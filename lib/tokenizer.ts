function isCjkCodePoint(code: number) {
  return (
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

function isAsciiWordCodePoint(code: number) {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

function isAsciiWhitespaceCodePoint(code: number) {
  return code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20;
}

export function countTextTokens(text: string, model: string) {
  if (!text) return 0;

  void model;

  let tokens = 0;
  let asciiRun = 0;
  let whitespaceRun = 0;
  let punctuationRun = 0;

  function flushAscii() {
    if (asciiRun > 0) {
      tokens += Math.ceil(asciiRun / 4);
      asciiRun = 0;
    }
  }

  function flushWhitespace() {
    if (whitespaceRun > 0) {
      tokens += Math.ceil(whitespaceRun / 16);
      whitespaceRun = 0;
    }
  }

  function flushPunctuation() {
    if (punctuationRun > 0) {
      tokens += Math.ceil(punctuationRun / 2);
      punctuationRun = 0;
    }
  }

  function flushRuns() {
    flushAscii();
    flushWhitespace();
    flushPunctuation();
  }

  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;

    if (isAsciiWordCodePoint(code)) {
      flushWhitespace();
      flushPunctuation();
      asciiRun += 1;
      continue;
    }

    if (isAsciiWhitespaceCodePoint(code)) {
      flushAscii();
      flushPunctuation();
      whitespaceRun += 1;
      continue;
    }

    if (code < 0x80) {
      flushAscii();
      flushWhitespace();
      punctuationRun += 1;
      continue;
    }

    flushRuns();
    tokens += isCjkCodePoint(code) ? 1 : 2;
  }

  flushRuns();

  return Math.max(1, tokens);
}
