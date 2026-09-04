import fs from 'fs';

const src = fs.readFileSync('generated/image-run_78nhgr1t.png').toString('base64');
const ip2p = fs.readFileSync('output/test_instructpix2pix.png').toString('base64');
const ledits = fs.readFileSync('output/test_ledits.png').toString('base64');

async function evaluate(label, resultBase64, instruction) {
  const prompt = [
    'You are an expert visual audit evaluator for source-conditioned AI image editing.',
    'Compare Image 1 (original source) with Image 2 (edited result).',
    `The user requested the modification: "${instruction}".`,
    '',
    'Evaluate these 4 questions carefully:',
    '1. Did the requested change occur? (Yes/No and explain)',
    '2. Did anything not requested change? (Identify any unintended changes to identity, clothing, background, lighting, objects, or say None)',
    '3. Was subject identity and appearance preserved? (Yes/No and explain)',
    '4. Was composition and geometry preserved where the prompt did not request changes? (Yes/No and explain)',
    '',
    'Format your response strictly as valid JSON:',
    '{',
    '  "requestedChangeOccurred": true,',
    '  "unintendedChangesDetected": false,',
    '  "subjectPreserved": true,',
    '  "compositionPreserved": true,',
    '  "summary": "concise overall verdict",',
    '  "details": {',
    '    "requestedChangeDetails": "...",',
    '    "unintendedChangeDetails": "...",',
    '    "subjectDetails": "...",',
    '    "compositionDetails": "..."',
    '  }',
    '}'
  ].join('\n');

  const response = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen2.5vl:7b',
      prompt,
      images: [src, resultBase64],
      stream: false,
      format: 'json'
    })
  });
  const data = await response.json();
  console.log(`=== ${label} Evaluation ===`);
  console.log(JSON.stringify(JSON.parse(data.response), null, 2));
}

await evaluate('InstructPix2Pix (blonde hair)', ip2p, 'make her hair blonde');
await evaluate('LEdits++ (blonde hair)', ledits, 'make her hair blonde');

const citySrc = fs.readFileSync('output/runpod-sdxl-smoke.png').toString('base64');
const cityIp2p = fs.readFileSync('output/output_city_ip2p.png').toString('base64');
const cityLedits = fs.readFileSync('output/output_city_ledits.png').toString('base64');

async function evaluateCity(label, resultBase64, instruction) {
  const prompt = [
    'You are an expert visual audit evaluator for source-conditioned AI image editing.',
    'Compare Image 1 (original source) with Image 2 (edited result).',
    `The user requested the modification: "${instruction}".`,
    '',
    'Evaluate these 4 questions carefully:',
    '1. Did the requested change occur? (Yes/No and explain)',
    '2. Did anything not requested change? (Identify any unintended changes to buildings, structures, skyline, or say None)',
    '3. Was subject identity and appearance (architecture, buildings) preserved? (Yes/No and explain)',
    '4. Was composition and geometry preserved where the prompt did not request changes? (Yes/No and explain)',
    '',
    'Format your response strictly as valid JSON:',
    '{',
    '  "requestedChangeOccurred": true,',
    '  "unintendedChangesDetected": false,',
    '  "subjectPreserved": true,',
    '  "compositionPreserved": true,',
    '  "summary": "concise overall verdict",',
    '  "details": {',
    '    "requestedChangeDetails": "...",',
    '    "unintendedChangeDetails": "...",',
    '    "subjectDetails": "...",',
    '    "compositionDetails": "..."',
    '  }',
    '}'
  ].join('\n');

  const response = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen2.5vl:7b',
      prompt,
      images: [citySrc, resultBase64],
      stream: false,
      format: 'json'
    })
  });
  const data = await response.json();
  console.log(`=== ${label} Evaluation ===`);
  console.log(JSON.stringify(JSON.parse(data.response), null, 2));
}

await evaluateCity('InstructPix2Pix (city starry night)', cityIp2p, 'turn the sky into a starry night sky with a full moon');
await evaluateCity('LEdits++ (city starry night)', cityLedits, 'turn the sky into a starry night sky with a full moon');

const f1 = fs.readFileSync('output/city_frame_01.png').toString('base64');
const f2 = fs.readFileSync('output/city_frame_02.png').toString('base64');
const f3 = fs.readFileSync('output/city_frame_03.png').toString('base64');

async function evaluateVideo() {
  const prompt = [
    'You are an expert video quality evaluator.',
    'Analyze these 3 sequential frames from an animated video (Frame 1, Frame 2, Frame 3).',
    'Evaluate question 5: Is subject identity and appearance temporally consistent across frames?',
    'Specifically:',
    '- Do the buildings, architectural geometry, and lighting maintain structural continuity without morphing, warping, or flickering?',
    '- Is camera motion smooth and coherent?',
    '',
    'Respond with valid JSON:',
    '{',
    '  "temporalConsistencyPreserved": true,',
    '  "subjectIdentityPreservedAcrossFrames": true,',
    '  "coherenceSummary": "...",',
    '  "details": "..."',
    '}'
  ].join('\n');

  const res = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen2.5vl:7b',
      prompt,
      images: [f1, f2, f3],
      stream: false,
      format: 'json'
    })
  });
  const data = await res.json();
  console.log('=== SVD Video Temporal Consistency Evaluation ===');
  console.log(JSON.stringify(JSON.parse(data.response), null, 2));
}

await evaluateVideo();


