const DRIVE_CHALLENGE_INPUT_REGEX = /<input[^>]*>/gi;
const INPUT_NAME_REGEX = /name=["']([^"']+)["']/i;
const INPUT_VALUE_REGEX = /value=["']([^"']*)["']/i;
const DRIVE_CHALLENGE_PARAM_NAMES = new Set(['confirm', 'uuid', 'at', 'id', 'export']);

export class RangeFetchController {
  constructor(url, { onChunk, onComplete, onError, firstByteTimeoutMs = 10000, midStreamTimeoutMs = 8000 }) {
    this.url = url;
    this.onChunk = onChunk;
    this.onComplete = onComplete;
    this.onError = onError;
    
    this.firstByteTimeoutMs = firstByteTimeoutMs;
    this.midStreamTimeoutMs = midStreamTimeoutMs;
    
    this.abortController = null;
    this.reader = null;
    this.isPaused = false;
    this.resumePromise = null;
    this.resumeResolve = null;
    
    this.firstByteTimer = null;
    this.midStreamTimer = null;
    
    this.bytesFetched = 0;
    this.challengeRetryCount = 0;
    this.seenChallengeFingerprints = new Set();
  }

  async fetchFrom(startByte, endByte = undefined) {
    this.abort(); // Cancel any existing fetch
    
    this.abortController = new AbortController();
    this.isPaused = false;
    this.resumeResolve = null;
    this.bytesFetched = 0;

    let rangeHeader = `bytes=${startByte}-`;
    if (endByte !== undefined) {
      rangeHeader += endByte;
    }

    try {
      this.firstByteTimer = setTimeout(() => {
        this.abort();
        if (this.onError) {
          this.onError(new Error('network-timeout: first byte'));
        }
      }, this.firstByteTimeoutMs);

      const isRetryWithToken = this.url.includes('confirm=');
      const headers = {};
      
      // Google Drive virus bypass (?confirm=t) often fails if a Range header is present
      // on the same request. If we are at byte 0 and retrying with a token, drop the range.
      if (!isRetryWithToken || startByte !== 0) {
        headers['Range'] = rangeHeader;
      }

      const response = await fetch(this.url, {
        headers: headers,
        signal: this.abortController.signal,
      });

      if (!response.ok && response.status !== 206 && response.status !== 200) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const contentType = response.headers.get('Content-Type') || '';
      if (contentType.includes('text/html') || contentType.includes('application/json')) {
        const text = await response.text();
        
        const challengeUrl = this._extractDriveChallengeUrl(text);
        const challengeParams = this._extractDriveChallengeParams(challengeUrl, text);
        
        if (challengeParams && challengeParams.has('confirm')) {
          if (this.challengeRetryCount >= 3) {
            console.error('[RangeFetchController] Bypassing failed. Retry budget exhausted.');
          } else {
            const fingerprint = this._buildChallengeFingerprint(challengeParams);
            if (this.seenChallengeFingerprints.has(fingerprint)) {
              console.error('[RangeFetchController] Bypassing failed. Received duplicate challenge payload.');
            } else {
              this.seenChallengeFingerprints.add(fingerprint);
              this.challengeRetryCount += 1;
              const nextUrl = this._buildChallengeRetryUrl(challengeParams, challengeUrl);
              this.url = nextUrl;
              return this.fetchFrom(startByte, endByte);
            }
          }
        }
        
        throw new Error(`Received non-audio content: ${contentType}. Body: ${text.substring(0, 200)}`);
      }
      this.challengeRetryCount = 0;
      this.seenChallengeFingerprints.clear();

      let totalSize = undefined;
      const contentRange = response.headers.get('Content-Range');
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/);
        if (match) {
          totalSize = parseInt(match[1], 10);
        }
      } else {
        const contentLength = response.headers.get('Content-Length');
        if (contentLength && startByte === 0) {
          totalSize = parseInt(contentLength, 10);
        }
      }

      this.reader = response.body.getReader();

      const resetMidStreamTimer = () => {
        if (this.midStreamTimer) {
          clearTimeout(this.midStreamTimer);
          this.midStreamTimer = null;
        }
        if (this.isPaused) return;
        this.midStreamTimer = setTimeout(() => {
          this.abort();
          if (this.onError) {
            this.onError(new Error('network-timeout: mid-stream'));
          }
        }, this.midStreamTimeoutMs);
      };

      while (true) {
        if (this.isPaused) {
          if (this.midStreamTimer) {
            clearTimeout(this.midStreamTimer);
            this.midStreamTimer = null;
          }
          await new Promise(resolve => {
            this.resumeResolve = resolve;
          });
        }
        
        if (!this.reader) break;

        resetMidStreamTimer();
        const { done, value } = await this.reader.read();

        if (this.firstByteTimer) {
          clearTimeout(this.firstByteTimer);
          this.firstByteTimer = null;
        }

        if (done) {
          if (this.midStreamTimer) {
            clearTimeout(this.midStreamTimer);
            this.midStreamTimer = null;
          }
          if (this.onComplete) this.onComplete();
          break;
        }

        if (value) {
          this.bytesFetched += value.length;
          if (this.onChunk) {
            this.onChunk(value, totalSize);
          }
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }
      if (this.onError) {
        this.onError(error);
      }
    } finally {
      if (this.firstByteTimer) {
        clearTimeout(this.firstByteTimer);
        this.firstByteTimer = null;
      }
      if (this.midStreamTimer) {
        clearTimeout(this.midStreamTimer);
        this.midStreamTimer = null;
      }
      this.reader = null;
      this.abortController = null;
    }
  }

  abort() {
    if (this.firstByteTimer) {
      clearTimeout(this.firstByteTimer);
      this.firstByteTimer = null;
    }
    if (this.midStreamTimer) {
      clearTimeout(this.midStreamTimer);
      this.midStreamTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.reader) {
      this.reader.cancel().catch(() => {});
      this.reader = null;
    }
    if (this.resumeResolve) {
      this.resumeResolve();
      this.resumeResolve = null;
    }
  }

  pause() {
    this.isPaused = true;
    if (this.midStreamTimer) {
      clearTimeout(this.midStreamTimer);
      this.midStreamTimer = null;
    }
  }

  resume() {
    this.isPaused = false;
    if (this.resumeResolve) {
      this.resumeResolve();
      this.resumeResolve = null;
    }
  }
  
  bufferedAhead() {
    return this.bytesFetched;
  }

  _extractDriveChallengeUrl(html) {
    const challengeUrl =
      this._extractChallengeUrlFromForm(html) ||
      this._extractChallengeUrlFromAnchor(html) ||
      this._extractChallengeUrlFromInlineConfirm(html);
    return challengeUrl || null;
  }

  _extractDriveChallengeParams(challengeUrl, html = '') {
    const mergedParams = new URLSearchParams();
    if (!challengeUrl) {
      this._extractHiddenChallengeParams(html, mergedParams);
      return mergedParams.has('confirm') ? mergedParams : null;
    }
    try {
      const decodedUrl = challengeUrl.replace(/&amp;/g, '&');
      const parsed = new URL(decodedUrl, 'https://drive.google.com');
      parsed.searchParams.forEach((value, key) => {
        if (key && value) {
          mergedParams.set(key, value);
        }
      });
      this._extractHiddenChallengeParams(html, mergedParams);
      return mergedParams.has('confirm') ? mergedParams : null;
    } catch {
      this._extractHiddenChallengeParams(html, mergedParams);
      return mergedParams.has('confirm') ? mergedParams : null;
    }
  }

  _extractChallengeUrlFromForm(html) {
    const downloadFormMatch = html.match(
      /<form[^>]*id=["']download-form["'][^>]*>/i,
    );
    const formTag = downloadFormMatch?.[0] || html.match(/<form[^>]*>/i)?.[0];
    if (!formTag) {
      return null;
    }
    const formMatch = formTag.match(/action=["']([^"']+)["']/i);
    if (formMatch?.[1]) {
      return formMatch[1];
    }
    return null;
  }

  _extractChallengeUrlFromAnchor(html) {
    const anchorMatch = html.match(/<a[^>]*href=["']([^"']*confirm=[^"']*)["'][^>]*>/i);
    return anchorMatch?.[1] || null;
  }

  _extractChallengeUrlFromInlineConfirm(html) {
    const confirmMatch = html.match(/confirm=([a-zA-Z0-9_-]+)/);
    if (!confirmMatch?.[1]) {
      return null;
    }
    return `https://drive.google.com/uc?confirm=${encodeURIComponent(confirmMatch[1])}`;
  }

  _buildChallengeRetryUrl(challengeParams, challengeUrl) {
    const base = new URL(this.url, globalThis.location.origin);
    const nextParams = new URLSearchParams(base.search);
    
    challengeParams.forEach((value, key) => {
      if (value && key) {
        nextParams.set(key, value);
      }
    });

    if (challengeUrl) {
      try {
        const decodedChallengeUrl = challengeUrl.replace(/&amp;/g, '&');
        const resolvedChallengeUrl = new URL(decodedChallengeUrl, 'https://drive.google.com').toString();
        nextParams.set('challengeUrl', resolvedChallengeUrl);
      } catch {}
    }
    
    nextParams.set('useUserContent', '1');
    base.search = nextParams.toString();
    return `${base.pathname}${base.search}`;
  }

  _buildChallengeFingerprint(challengeParams) {
    const entries = [];
    challengeParams.forEach((value, key) => {
      entries.push(`${key}=${value}`);
    });
    entries.sort();
    return entries.join('&');
  }

  _extractHiddenChallengeParams(html, params) {
    if (!html || !params) {
      return;
    }
    DRIVE_CHALLENGE_INPUT_REGEX.lastIndex = 0;
    let match;
    while ((match = DRIVE_CHALLENGE_INPUT_REGEX.exec(html)) !== null) {
      const input = match[0];
      const nameMatch = input.match(INPUT_NAME_REGEX);
      const name = nameMatch?.[1]?.toLowerCase();

      if (!name || !DRIVE_CHALLENGE_PARAM_NAMES.has(name)) {
        continue;
      }
      
      const valueMatch = input.match(INPUT_VALUE_REGEX);
      const value = valueMatch?.[1];
      if (value !== undefined) {
        params.set(name, value);
      }
    }
  }
}
