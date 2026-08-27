// ============================================================
// Vrew 이미지 자동 배치 — 핵심 로직
// vrew_build.py를 그대로 옮긴 것. 결과가 1비트도 달라지면 안 된다.
// ============================================================

const VIDEO_RATIO = 16 / 9;

// 실제 Vrew 프로젝트에서 추출한 켄번스 상수
export const KENBURNS = {
  'zoom-in': [
    { scale: 0.77, centerX: 0.5, centerY: 0.5 },
    { scale: 0.63, centerX: 0.5, centerY: 0.5 },
  ],
  'zoom-out': [
    { scale: 0.63, centerX: 0.5, centerY: 0.5 },
    { scale: 0.77, centerX: 0.5, centerY: 0.5 },
  ],
  'left-to-right': [
    { scale: 0.7, centerX: 0.42, centerY: 0.5 },
    { scale: 0.7, centerX: 0.5800000000000001, centerY: 0.5 },
  ],
  'right-to-left': [
    { scale: 0.7, centerX: 0.5800000000000001, centerY: 0.5 },
    { scale: 0.7, centerX: 0.42, centerY: 0.5 },
  ],
  'top-to-bottom': [
    { scale: 0.7, centerX: 0.5, centerY: 0.42 },
    { scale: 0.7, centerX: 0.5, centerY: 0.5800000000000001 },
  ],
  'bottom-to-top': [
    { scale: 0.7, centerX: 0.5, centerY: 0.5800000000000001 },
    { scale: 0.7, centerX: 0.5, centerY: 0.42 },
  ],
};
export const ANIM_CYCLE = Object.keys(KENBURNS);

const NUMBERED = /^\s*(\d+)\.\s*(.*)$/;
const IMAGE_NAME = /^(\d+)-(\d+)$/;

// ---------------------------------------------------------------- 대본 파싱

// 헤더 문구가 프로젝트마다 다르므로 문구에 의존하지 않는다.
// 번호가 1로 되돌아가는 지점을 블록 경계로 보고,
// 한글 비율이 가장 높은 블록을 대본으로 택한다.
export function parseScript(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    const m = NUMBERED.exec(line);
    if (m) entries.push([parseInt(m[1], 10), m[2].trim()]);
  }
  if (!entries.length) throw new Error('번호가 붙은 문장을 찾지 못했습니다');

  const blocks = [];
  let cur = [entries[0]];
  for (let i = 1; i < entries.length; i++) {
    if (entries[i][0] <= cur[cur.length - 1][0]) { blocks.push(cur); cur = []; }
    cur.push(entries[i]);
  }
  blocks.push(cur);

  const hangulRatio = (block) => {
    const joined = block.map((e) => e[1]).join('');
    if (!joined.length) return 0;
    let n = 0;
    for (const ch of joined) if (ch >= '가' && ch <= '힣') n++;
    return n / joined.length;
  };

  let best = blocks[0];
  for (const b of blocks) if (hangulRatio(b) > hangulRatio(best)) best = b;
  if (hangulRatio(best) < 0.1) throw new Error('한글 대본을 찾지 못했습니다');

  const script = new Map();
  for (const [num, txt] of best) {
    if (script.has(num)) throw new Error('대본 번호가 중복됩니다: ' + num);
    script.set(num, txt);
  }
  return script;
}

// 파일명 NNN-V 에서 앞자리를 대본 번호로 읽는다.
export function parseImages(files, variant = null) {
  const buckets = new Map();
  for (const f of files) {
    const stem = f.name.replace(/\.[^.]+$/, '');
    const m = IMAGE_NAME.exec(stem);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    const v = parseInt(m[2], 10);
    if (!buckets.has(num)) buckets.set(num, new Map());
    buckets.get(num).set(v, f);
  }

  const images = new Map();
  for (const [num, vs] of buckets) {
    if (variant !== null && vs.has(variant)) images.set(num, vs.get(variant));
    else images.set(num, vs.get(Math.min(...vs.keys())));
  }
  return images;
}

// ---------------------------------------------------------------- clip 정렬

export function clipText(clip) {
  let out = '';
  for (const cap of clip.captions || []) {
    for (const op of cap.text || []) out += op.insert || '';
  }
  return out;
}

export function normalize(text) {
  return text
    .normalize('NFKC')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[\s.,!?"'~…·\-—()[\]]/g, '');
}

function bisectRight(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < arr[mid]) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// clip 경계는 대본 문장 경계와 일치하지 않는다. TTS가 문장을
// 호흡 단위로 잘라 한 clip에 두 문장이 섞이기도 한다. 그래서
// 전체 자막을 하나로 이어 붙여 위치를 찾은 뒤 clip을 역산한다.
export function align(script, clips, report = null) {
  const norm = clips.map((c) => normalize(clipText(c)));
  const stream = norm.join('');

  const offsets = [];
  let acc = 0;
  for (const t of norm) { offsets.push(acc); acc += t.length; }

  const starts = new Map();
  let cursor = 0;
  let prevClip = -1;

  for (const num of [...script.keys()].sort((a, b) => a - b)) {
    const target = normalize(script.get(num));
    const note = { num, text: script.get(num), len: target.length };

    if (!target) {
      note.status = 'empty';
      if (report) report.push(note);
      continue;
    }

    let at = stream.indexOf(target, cursor);
    let how = 'full';

    if (at < 0) {
      for (const cut of [40, 30, 20, 12]) {
        if (target.length <= cut) continue;
        at = stream.indexOf(target.slice(0, cut), cursor);
        if (at >= 0) { how = 'partial:' + cut; break; }
      }
    }

    if (at < 0) {
      note.status = 'notfound';
      if (report) { report.push(note); continue; }
      throw new Error(num + '번 문장을 자막에서 찾지 못했습니다: ' + script.get(num).slice(0, 40));
    }

    // 문장이 짧으면 여러 곳에 나올 수 있다 — 잘못 잡힐 위험
    const occurrences = target.length >= 4 ? countAll(stream, target) : 99;

    let idx = bisectRight(offsets, at) - 1;
    let bumped = false;
    if (idx <= prevClip) { idx = prevClip + 1; bumped = true; }

    if (idx >= clips.length) {
      note.status = 'overflow';
      if (report) { report.push(note); continue; }
      throw new Error(num + '번 문장의 clip 범위를 벗어났습니다');
    }

    note.status = 'ok';
    note.clip = idx;
    note.how = how;
    note.occurrences = occurrences;
    note.bumped = bumped;
    if (report) report.push(note);

    starts.set(num, idx);
    prevClip = idx;
    cursor = at + Math.max(1, Math.floor(target.length / 2));
  }
  return starts;
}

function countAll(hay, needle) {
  let n = 0, i = 0;
  while (true) {
    const at = hay.indexOf(needle, i);
    if (at < 0) break;
    n++;
    i = at + 1;
    if (n > 9) break;
  }
  return n;
}

// 실행 전 위험 요소를 미리 훑는다. 던지지 않고 목록으로 돌려준다.
// level: 'stop'  = 이대로는 안 됨
//        'warn'  = 되지만 확인 권장
export function diagnose(project, script, images, clips) {
  const out = [];
  const add = (level, title, detail) => out.push({ level, title, detail });

  // --- 짝 맞추기
  const missImg = [...script.keys()].filter((n) => !images.has(n)).sort((a, b) => a - b);
  const missTxt = [...images.keys()].filter((n) => !script.has(n)).sort((a, b) => a - b);
  if (missImg.length) {
    add('warn', '이미지가 없는 장면 ' + missImg.length + '개',
        missImg.join(', ') + '번 — 이 자리는 앞 이미지가 이어서 채웁니다.');
  }
  if (missTxt.length) {
    add('warn', '장면 목록에 없는 이미지 ' + missTxt.length + '장',
        missTxt.join(', ') + '번 — 사용하지 않습니다.');
  }
  const usable = [...script.keys()].filter((n) => images.has(n));
  if (!usable.length) {
    add('stop', '맞는 짝이 하나도 없습니다',
        '이미지 번호와 장면 번호가 서로 맞지 않습니다. 폴더를 잘못 고르지 않았는지 확인해 주세요.');
    return out;
  }

  // --- 번호 빠짐
  const nums = usable.slice().sort((a, b) => a - b);
  const gaps = [];
  for (let i = nums[0]; i <= nums[nums.length - 1]; i++) if (!nums.includes(i)) gaps.push(i);
  if (gaps.length) add('warn', '중간에 빠진 번호', gaps.join(', ') + '번');

  // --- 이미 들어있는 이미지
  const already = Object.values(project.props.tracks).filter((v) => v.type === 'image').length;
  if (already) {
    add('warn', '이미 이미지 ' + already + '장이 들어 있습니다',
        '지우지 않고 그 위에 추가합니다. 겹쳐 보일 수 있으니 이미지가 없는 Vrew 파일을 쓰는 편이 좋습니다.');
  }

  // --- 자막 정렬 시험 (실제로 돌려본다)
  const sub = new Map();
  for (const n of usable) sub.set(n, script.get(n));
  const report = [];
  let starts;
  try {
    starts = align(sub, clips, report);
  } catch (e) {
    add('stop', '자막 맞추기 실패', e.message);
    return out;
  }

  const notfound = report.filter((r) => r.status === 'notfound');
  if (notfound.length) {
    add('stop', '자막에서 찾지 못한 장면 ' + notfound.length + '개',
        notfound.map((r) => r.num + '번 "' + r.text.slice(0, 26) + '…"').join('\n') +
        '\n\n장면 목록과 Vrew 파일이 서로 다른 이야기일 수 있습니다.');
  }

  const partial = report.filter((r) => r.status === 'ok' && r.how !== 'full');
  if (partial.length) {
    add('warn', '문장 앞부분만으로 찾은 장면 ' + partial.length + '개',
        partial.map((r) => r.num + '번').join(', ') +
        ' — 자막이 조금 고쳐진 듯합니다. 위치가 어긋날 수 있으니 확인해 주세요.');
  }

  const ambiguous = report.filter((r) => r.status === 'ok' && r.occurrences > 1 && r.occurrences < 90);
  if (ambiguous.length) {
    add('warn', '같은 말이 여러 번 나오는 장면 ' + ambiguous.length + '개',
        ambiguous.map((r) => r.num + '번(' + r.occurrences + '곳)').join(', ') +
        ' — 문장이 짧아 다른 곳과 헷갈릴 수 있습니다.');
  }

  const shorts = report.filter((r) => r.status === 'ok' && r.len < 8);
  if (shorts.length) {
    add('warn', '너무 짧은 장면 문장 ' + shorts.length + '개',
        shorts.map((r) => r.num + '번 "' + r.text.slice(0, 18) + '"').join(', '));
  }

  // --- 순서 뒤집힘 / 구간 길이
  if (starts && starts.size) {
    const ns = [...starts.keys()].sort((a, b) => a - b);
    const lens = [];
    for (let i = 0; i < ns.length; i++) {
      const st = starts.get(ns[i]);
      const en = (i + 1 < ns.length) ? starts.get(ns[i + 1]) - 1 : clips.length - 1;
      lens.push({ num: ns[i], len: en - st + 1 });
    }
    const tiny = lens.filter((x) => x.len <= 2);
    if (tiny.length) {
      add('warn', '너무 짧게 지나가는 장면 ' + tiny.length + '개',
          tiny.map((x) => x.num + '번(자막 ' + x.len + '개)').join(', ') +
          ' — 거의 안 보이고 지나갑니다.');
    }
    const sorted = lens.map((x) => x.len).sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)] || 1;
    const huge = lens.filter((x) => x.len > mid * 4);
    if (huge.length) {
      add('warn', '유난히 오래 머무는 장면 ' + huge.length + '개',
          huge.map((x) => x.num + '번(자막 ' + x.len + '개)').join(', ') +
          ' — 중간 장면을 못 찾았을 수 있습니다.');
    }
    const first = starts.get(ns[0]);
    if (first > 0) {
      add('info', '앞부분 자막 ' + first + '개는 비워 둡니다',
          '이야기 시작 전 도입부입니다. 여기에는 따로 만든 영상을 넣으세요.');
    }
  }

  return out;
}

// 대본 1번 앞은 인트로 후킹이라 본편 이미지를 깔지 않는다.
// 마지막 이미지는 언제나 마지막 clip까지 늘린다.
export function buildRanges(starts, totalClips, coverIntro = false) {
  const nums = [...starts.keys()].sort((a, b) => a - b);
  const ranges = new Map();
  for (let i = 0; i < nums.length; i++) {
    const start = (coverIntro && i === 0) ? 0 : starts.get(nums[i]);
    const end = (i + 1 < nums.length) ? starts.get(nums[i + 1]) - 1 : totalClips - 1;
    if (end < start) throw new Error(nums[i] + '번 구간이 비었습니다');
    ranges.set(nums[i], [start, end]);
  }
  return ranges;
}

// ---------------------------------------------------------------- 트랙 생성

// fillType=cut: 화면에 여백이 남지 않게 덮는 위치/크기
export function coverBox(ratio) {
  let width, height;
  if (ratio >= VIDEO_RATIO) { height = 1.0; width = ratio / VIDEO_RATIO; }
  else { width = 1.0; height = VIDEO_RATIO / ratio; }
  return { xPos: (1.0 - width) / 2, yPos: (1.0 - height) / 2, width, height };
}

// JPEG/PNG 헤더에서 크기를 직접 읽는다.
export function imageRatio(u8) {
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    const dv = new DataView(u8.buffer, u8.byteOffset);
    return dv.getUint32(16) / dv.getUint32(20);
  }
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    const dv = new DataView(u8.buffer, u8.byteOffset);
    let i = 2;
    while (i < u8.length - 9) {
      if (u8[i] !== 0xff) { i++; continue; }
      const marker = u8[i + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const seg = dv.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return dv.getUint16(i + 7) / dv.getUint16(i + 5);
      }
      i += 2 + seg;
    }
  }
  throw new Error('이미지 크기를 읽지 못했습니다');
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function makeId(rand) {
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

function makeUuid(rand) {
  const hex = [];
  for (let i = 0; i < 32; i++) hex.push(Math.floor(rand() * 16).toString(16));
  hex[12] = '4';
  hex[16] = (parseInt(hex[16], 16) & 0x3 | 0x8).toString(16);
  const h = hex.join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 배치

export function inject(project, ranges, images, ratios, seed = 20260828) {
  const rand = mulberry32(seed);
  const clips = project.transcript.clips;
  const tracks = project.props.tracks;
  const assets = project.props.assets;
  const files = project.files;

  const plan = [];
  const nums = [...ranges.keys()].sort((a, b) => a - b);

  nums.forEach((num, order) => {
    const [start, end] = ranges.get(num);
    const file = images.get(num);
    const ratio = ratios.get(num);

    const mediaId = makeUuid(rand);
    const trackId = makeId(rand);
    const assetId = makeUuid(rand);
    const anim = ANIM_CYCLE[order % ANIM_CYCLE.length];
    const [from, to] = KENBURNS[anim];
    const box = coverBox(ratio);

    tracks[trackId] = {
      trackId,
      mediaId,
      xPos: box.xPos,
      yPos: box.yPos,
      height: box.height,
      width: box.width,
      rotation: 0,
      zIndex: 0,
      type: 'image',
      originalWidthHeightRatio: ratio,
      importType: 'agent',
      kenburnsAnimationInfo: { type: anim, from: { ...from }, to: { ...to } },
      editInfo: {},
      stats: { fillType: 'cut', isTransparent: false },
    };
    assets[assetId] = { trackIds: [trackId], role: 'sub' };

    const ext = (file.name.match(/\.[^.]+$/) || ['.jpeg'])[0].toLowerCase();
    files.push({
      version: 1,
      mediaId,
      sourceOrigin: 'LOCAL',
      fileSize: file.size,
      name: mediaId + ext,
      type: 'Image',
      fileLocation: 'IN_MEMORY',
    });

    // 구간 내 모든 clip에 같은 assetId를 붙여 이미지를 이어 붙인다
    for (let i = start; i <= end; i++) {
      if (!clips[i].assetIds) clips[i].assetIds = [];
      clips[i].assetIds.push(assetId);
    }

    plan.push({ num, start, end, clips: end - start + 1, anim, file, mediaName: mediaId + ext });
  });

  return plan;
}
