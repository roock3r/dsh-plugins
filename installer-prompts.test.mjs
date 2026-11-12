import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { prompt } from './install.mjs';

function terminalFixture() {
  const previousTerm = process.env.TERM;
  process.env.TERM = 'xterm-256color';
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  let transcript = '';
  const output = new Writable({ write(chunk, encoding, callback) { transcript += chunk.toString(); callback(); } });
  output.columns = 160;
  return {
    input, output,
    transcript: () => transcript,
    // Readline's ANSI erase-to-end operation removes the previously rendered
    // prompt. Inspect the last redraw, rather than just searching old output.
    visible: () => {
      const lastErase = transcript.lastIndexOf('\x1b[0J');
      return stripVTControlCharacters(transcript.slice(lastErase < 0 ? 0 : lastErase + 4));
    },
    dispose: () => {
      input.destroy(); output.destroy();
      if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm;
    },
  };
}

test('gateway and host labels remain visible before input and after line editing', async () => {
  const terminal = terminalFixture();
  try {
    const gateway = prompt('Gateway address for pc: ', { ...terminal, hint: 'Enter the address without /v1, then press Enter.' });
    assert.match(terminal.transcript(), /Enter the address without \/v1, then press Enter\./);
    assert.equal(terminal.visible(), 'Gateway address for pc: ');
    terminal.input.write('http://model-host.local:8082');
    terminal.input.write('\x7f3');
    assert.equal(terminal.visible(), 'Gateway address for pc: http://model-host.local:8083');
    terminal.input.write('\r');
    assert.equal(await gateway, 'http://model-host.local:8083');
    assert.equal(terminal.input.isRaw, false);

    const label = prompt('Host label [Model host]: ', terminal);
    assert.equal(terminal.visible(), 'Host label [Model host]: ');
    terminal.input.write('  Office inference server  \r');
    assert.equal(await label, 'Office inference server');
  } finally { terminal.dispose(); }
});

test('pressing Enter accepts an empty answer for a caller-provided default', async () => {
  const terminal = terminalFixture();
  try {
    const answer = prompt('Host label [Model host]: ', terminal);
    assert.equal(terminal.visible(), 'Host label [Model host]: ');
    terminal.input.write('\r');
    assert.equal(await answer, '');
  } finally { terminal.dispose(); }
});

test('API key prompt is visible but typing and editing emit no secret characters', async () => {
  const terminal = terminalFixture();
  try {
    const answer = prompt('Gateway API key (hidden): ', {
      ...terminal, hidden: true, hint: 'Characters will not appear. Type the key, then press Enter.',
    });
    assert.match(terminal.transcript(), /Characters will not appear/);
    assert.equal(terminal.visible(), 'Gateway API key (hidden): ');
    const beforeTyping = terminal.transcript();
    terminal.input.write('synthetic-secret-wrong');
    terminal.input.write('\x7f\x7f\x7f\x7f\x7fvalue');
    assert.equal(terminal.transcript(), beforeTyping);
    terminal.input.write('\r');
    assert.equal(await answer, 'synthetic-secret-value');
    assert.equal(terminal.transcript(), `${beforeTyping}\n`);
    assert.equal(terminal.input.isRaw, false);

    const label = prompt('Host label [Model host]: ', terminal);
    assert.equal(terminal.visible(), 'Host label [Model host]: ');
    terminal.input.write('Visible again\r');
    assert.equal(await label, 'Visible again');
  } finally { terminal.dispose(); }
});

test('Ctrl-C cancels a hidden prompt without echoing its partial value', async () => {
  const terminal = terminalFixture();
  try {
    const answer = prompt('Gateway API key (hidden): ', { ...terminal, hidden: true });
    const rejection = assert.rejects(answer, /Installation canceled/);
    const beforeTyping = terminal.transcript();
    terminal.input.write('synthetic-partial-secret');
    terminal.input.write('\x03');
    await rejection;
    assert.equal(terminal.transcript(), `${beforeTyping}\n`);
    assert.equal(terminal.input.isRaw, false);
  } finally { terminal.dispose(); }
});

test('closed input rejects promptly instead of leaving the installer waiting', async () => {
  const terminal = terminalFixture();
  try {
    const answer = prompt('Gateway address: ', terminal);
    const rejection = assert.rejects(answer, /Input closed before an answer/);
    terminal.input.end();
    await rejection;
    assert.equal(terminal.input.isRaw, false);
  } finally { terminal.dispose(); }
});

test('noninteractive input is refused before any prompt or secret is read', () => {
  const terminal = terminalFixture();
  try {
    terminal.input.isTTY = false;
    assert.throws(() => prompt('Gateway API key (hidden): ', { ...terminal, hidden: true }), /Interactive input is required/);
    assert.equal(terminal.transcript(), '');
  } finally { terminal.dispose(); }
});
