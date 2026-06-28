import assert from 'node:assert/strict';
import test from 'node:test';

import { clampVolume, sendPreloadCommand } from './audio_bridge_transport.js';

test('clampVolume constrains values into 0..1', () => {
  assert.equal(clampVolume(-1), 0);
  assert.equal(clampVolume(0.5), 0.5);
  assert.equal(clampVolume(2), 1);
});

test('sendPreloadCommand calls sendPlaybackWorkerCommand with correct arguments', async () => {
  let calledType, calledPayload;
  const sendCommand = async (type, payload) => {
    calledType = type;
    calledPayload = payload;
  };
  const onError = () => {};

  await sendPreloadCommand(sendCommand, onError, 'preload', { trackId: '123' });

  assert.equal(calledType, 'preload');
  assert.deepEqual(calledPayload, { trackId: '123' });
});

test('sendPreloadCommand calls onPreloadErrorCallback with error message if Error is thrown', async () => {
  const sendCommand = async () => {
    throw new Error('Preload failed');
  };
  let errorReceived;
  const onError = (err) => {
    errorReceived = err;
  };

  await sendPreloadCommand(sendCommand, onError, 'preload', {});

  assert.equal(errorReceived, 'Preload failed');
});

test('sendPreloadCommand calls onPreloadErrorCallback with stringified error if non-Error is thrown', async () => {
  const sendCommand = async () => {
    throw 'String error';
  };
  let errorReceived;
  const onError = (err) => {
    errorReceived = err;
  };

  await sendPreloadCommand(sendCommand, onError, 'preload', {});

  assert.equal(errorReceived, 'String error');
});

test('sendPreloadCommand does not throw if onPreloadErrorCallback is not a function when an error occurs', async () => {
  const sendCommand = async () => {
    throw new Error('Failed');
  };

  // This should not throw an exception
  await sendPreloadCommand(sendCommand, null, 'preload', {});
  await sendPreloadCommand(sendCommand, undefined, 'preload', {});
  await sendPreloadCommand(sendCommand, 'not-a-function', 'preload', {});
});
