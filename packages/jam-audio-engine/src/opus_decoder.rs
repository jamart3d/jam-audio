#[cfg(all(not(target_arch = "wasm32"), not(test)))]
pub use symphonia_adapter_libopus::OpusDecoder;

#[cfg(any(target_arch = "wasm32", test))]
mod pure_rust {
    use std::fmt;

    use symphonia_core::audio::{
        AsAudioBufferRef, AudioBuffer, AudioBufferRef, Channels, Layout, Signal, SignalSpec,
    };
    use symphonia_core::codecs::{
        self, CODEC_TYPE_OPUS, CodecDescriptor, CodecParameters, DecoderOptions, FinalizeResult,
    };
    use symphonia_core::errors::{Error, Result, unsupported_error};
    use symphonia_core::formats::Packet;
    use symphonia_core::io::{BufReader, ReadBytes};
    use symphonia_core::support_codec;
    use unopus::{
        OpusDecoder as RawOpusDecoder, opus_decode_float, opus_decoder_create, opus_decoder_destroy,
    };

    const DEFAULT_SAMPLE_RATE: usize = 48_000;
    const DEFAULT_SAMPLES_PER_CHANNEL: usize = DEFAULT_SAMPLE_RATE * 20 / 1000;
    const MAX_SAMPLE_RATE: usize = 48_000;
    const MAX_SAMPLES_PER_CHANNEL: usize = MAX_SAMPLE_RATE * 120 / 1000;

    pub struct OpusDecoder {
        params: CodecParameters,
        decoder: *mut RawOpusDecoder,
        buf: AudioBuffer<f32>,
        pcm: [f32; MAX_SAMPLES_PER_CHANNEL * 2],
        samples_per_channel: usize,
        sample_rate: u32,
        num_channels: usize,
        pre_skip: usize,
    }

    unsafe impl Send for OpusDecoder {}
    unsafe impl Sync for OpusDecoder {}

    impl Drop for OpusDecoder {
        fn drop(&mut self) {
            unsafe {
                if !self.decoder.is_null() {
                    opus_decoder_destroy(self.decoder);
                }
            }
        }
    }

    impl fmt::Debug for OpusDecoder {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("OpusDecoder")
                .field("params", &self.params)
                .field("decoder", &"<unopus>")
                .field("buf", &"<buf>")
                .field("samples_per_channel", &self.samples_per_channel)
                .field("sample_rate", &self.sample_rate)
                .field("num_channels", &self.num_channels)
                .field("pre_skip", &self.pre_skip)
                .finish()
        }
    }

    fn parse_pre_skip(buf: &[u8]) -> Result<usize> {
        let mut reader = BufReader::new(buf);
        let mut header = [0; 8];
        reader.read_buf_exact(&mut header)?;
        reader.read_byte()?;
        reader.read_byte()?;
        let pre_skip = reader.read_u16()?;
        Ok(pre_skip as usize)
    }

    fn map_to_channels(num_channels: usize) -> Option<Channels> {
        let channels = match num_channels {
            1 => Layout::Mono.into_channels(),
            2 => Layout::Stereo.into_channels(),
            _ => return None,
        };

        Some(channels)
    }

    fn audio_buffer(
        sample_rate: u32,
        samples_per_channel: u64,
        num_channels: usize,
    ) -> AudioBuffer<f32> {
        let channels = map_to_channels(num_channels).expect("invalid channels");
        let spec = SignalSpec::new(sample_rate, channels);
        AudioBuffer::new(samples_per_channel, spec)
    }

    fn make_decoder(sample_rate: u32, num_channels: usize) -> Result<*mut RawOpusDecoder> {
        let mut err = 0;
        let decoder =
            unsafe { opus_decoder_create(sample_rate as i32, num_channels as i32, &mut err) };
        if decoder.is_null() || err != 0 {
            return Err(Error::DecodeError("opus: error creating decoder"));
        }
        Ok(decoder)
    }

    impl codecs::Decoder for OpusDecoder {
        fn try_new(params: &CodecParameters, _opts: &DecoderOptions) -> Result<Self>
        where
            Self: Sized,
        {
            let num_channels = if let Some(channels) = &params.channels {
                channels.count()
            } else {
                return unsupported_error("opus: channels or channel layout is required");
            };

            let sample_rate = if let Some(sample_rate) = params.sample_rate {
                sample_rate
            } else {
                return unsupported_error("opus: sample rate required");
            };

            if !(1..=2).contains(&num_channels) {
                return unsupported_error("opus: unsupported number of channels");
            }

            let pre_skip = if let Some(extra_data) = &params.extra_data {
                parse_pre_skip(extra_data).unwrap_or_default()
            } else {
                0
            };

            Ok(Self {
                params: params.to_owned(),
                decoder: make_decoder(sample_rate, num_channels)?,
                buf: audio_buffer(
                    sample_rate,
                    DEFAULT_SAMPLES_PER_CHANNEL as u64,
                    num_channels,
                ),
                pcm: [0.0; _],
                samples_per_channel: DEFAULT_SAMPLES_PER_CHANNEL,
                sample_rate,
                num_channels,
                pre_skip,
            })
        }

        fn supported_codecs() -> &'static [CodecDescriptor]
        where
            Self: Sized,
        {
            &[support_codec!(CODEC_TYPE_OPUS, "opus", "Opus")]
        }

        fn reset(&mut self) {
            if let Ok(decoder) = make_decoder(self.sample_rate, self.num_channels) {
                self.decoder = decoder;
                self.pre_skip = self
                    .params
                    .extra_data
                    .as_deref()
                    .and_then(|extra_data| parse_pre_skip(extra_data).ok())
                    .unwrap_or_default();
                self.buf.clear();
            }
        }

        fn codec_params(&self) -> &CodecParameters {
            &self.params
        }

        fn decode(&mut self, packet: &Packet) -> Result<AudioBufferRef<'_>> {
            let samples_per_channel = unsafe {
                opus_decode_float(
                    self.decoder,
                    packet.data.as_ptr(),
                    packet.data.len() as i32,
                    self.pcm.as_mut_ptr(),
                    MAX_SAMPLES_PER_CHANNEL as i32,
                    0,
                )
            };

            if samples_per_channel < 0 {
                return Err(Error::DecodeError("opus: decode failed"));
            }
            let samples_per_channel = samples_per_channel as usize;

            if samples_per_channel != self.samples_per_channel {
                self.buf = audio_buffer(
                    self.sample_rate,
                    samples_per_channel as u64,
                    self.num_channels,
                );
                self.samples_per_channel = samples_per_channel;
            }

            let samples = samples_per_channel * self.num_channels;
            let pcm = &self.pcm[..samples];

            self.buf.clear();
            self.buf.render_reserved(None);
            match self.num_channels {
                1 => {
                    self.buf.chan_mut(0).copy_from_slice(pcm);
                }
                2 => {
                    let (l, r) = self.buf.chan_pair_mut(0, 1);
                    for (i, j) in (0..samples).step_by(2).enumerate() {
                        l[i] = pcm[j];
                        r[i] = pcm[j + 1];
                    }
                }
                _ => {}
            }

            self.buf.trim(
                packet.trim_start() as usize
                    + (self.pre_skip * self.sample_rate as usize) / DEFAULT_SAMPLE_RATE,
                packet.trim_end() as usize,
            );
            self.pre_skip = 0;
            Ok(self.buf.as_audio_buffer_ref())
        }

        fn finalize(&mut self) -> FinalizeResult {
            FinalizeResult::default()
        }

        fn last_decoded(&self) -> AudioBufferRef<'_> {
            self.buf.as_audio_buffer_ref()
        }
    }
}

#[cfg(any(target_arch = "wasm32", test))]
pub use pure_rust::OpusDecoder;
