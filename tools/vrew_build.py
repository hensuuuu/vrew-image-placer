# -*- coding: utf-8 -*-
"""Vrew 프로젝트에 대본-이미지 매칭 결과를 배치한다.

Vrew의 AI 이미지 배치를 대체하는 결정론적 구현.
  - 대본 번호 <-> output 이미지 파일명 앞자리 매칭
  - 각 이미지를 매칭 문장 시작 clip부터 다음 문장 시작 직전 clip까지 배치
  - 마지막 이미지는 프로젝트 마지막 clip까지
  - fillType=cut 고정, 켄번스 애니메이션 6종 순환
"""
import bisect
import json
import re
import shutil
import string
import unicodedata
import uuid
import zipfile
from pathlib import Path

VIDEO_RATIO = 16 / 9
SCRIPT_HEADERS = ("[대본", "STEP 2")
PROMPT_HEADER = "===프롬프트==="
NUMBERED = re.compile(r"^\s*(\d+)\.\s*(.*)$")
IMAGE_NAME = re.compile(r"^(\d+)-(\d+)$")

# 실제 Vrew 프로젝트에서 추출한 켄번스 상수
KENBURNS = {
    "zoom-in":       ({"scale": 0.77, "centerX": 0.5,  "centerY": 0.5},
                      {"scale": 0.63, "centerX": 0.5,  "centerY": 0.5}),
    "zoom-out":      ({"scale": 0.63, "centerX": 0.5,  "centerY": 0.5},
                      {"scale": 0.77, "centerX": 0.5,  "centerY": 0.5}),
    "left-to-right": ({"scale": 0.7,  "centerX": 0.42, "centerY": 0.5},
                      {"scale": 0.7,  "centerX": 0.58, "centerY": 0.5}),
    "right-to-left": ({"scale": 0.7,  "centerX": 0.58, "centerY": 0.5},
                      {"scale": 0.7,  "centerX": 0.42, "centerY": 0.5}),
    "top-to-bottom": ({"scale": 0.7,  "centerX": 0.5,  "centerY": 0.42},
                      {"scale": 0.7,  "centerX": 0.5,  "centerY": 0.58}),
    "bottom-to-top": ({"scale": 0.7,  "centerX": 0.5,  "centerY": 0.58},
                      {"scale": 0.7,  "centerX": 0.5,  "centerY": 0.42}),
}
ANIM_CYCLE = list(KENBURNS)

ALPHABET = string.ascii_letters + string.digits + "_-"


def make_id(rng):
    return "".join(rng.choice(ALPHABET) for _ in range(10))


# ---------------------------------------------------------------- 파싱

def parse_script(path):
    """대본 블록만 골라 {번호: 문장}.

    헤더 문구가 프로젝트마다 다르므로 문구에 의존하지 않는다.
    파일 전체에서 `N. ` 줄을 모은 뒤, 1부터 다시 시작하는 지점을
    블록 경계로 보고 한글 비율이 가장 높은 블록을 대본으로 택한다.
    (영어 프롬프트 블록과 번호가 겹치는 문제를 이렇게 피한다)
    """
    lines = Path(path).read_text(encoding="utf-8").split(chr(10))

    entries = []
    for line in lines:
        m = NUMBERED.match(line)
        if m:
            entries.append((int(m.group(1)), m.group(2).strip()))

    if not entries:
        raise ValueError("번호가 붙은 문장을 찾지 못했다")

    # 번호가 되돌아가는 지점에서 블록을 자른다
    blocks, cur = [], [entries[0]]
    for num, text in entries[1:]:
        if num <= cur[-1][0]:
            blocks.append(cur)
            cur = []
        cur.append((num, text))
    blocks.append(cur)

    def hangul_ratio(block):
        joined = "".join(t for _, t in block)
        if not joined:
            return 0.0
        return sum(1 for ch in joined if "가" <= ch <= "힣") / len(joined)

    best = max(blocks, key=hangul_ratio)
    if hangul_ratio(best) < 0.1:
        raise ValueError("한글 대본 블록을 찾지 못했다")

    script = {}
    for num, text in best:
        if num in script:
            raise ValueError(f"대본 번호 중복: {num}")
        script[num] = text
    return script


def parse_images(folder, variant=None):
    """{번호: Path}. variant 지정 시 해당 variant 우선, 없으면 사전순 첫 파일."""
    buckets = {}
    for p in sorted(Path(folder).iterdir()):
        if not p.is_file():
            continue
        m = IMAGE_NAME.match(p.stem)
        if not m:
            continue
        buckets.setdefault(int(m.group(1)), {})[int(m.group(2))] = p

    images = {}
    for num, variants in buckets.items():
        if variant is not None and variant in variants:
            images[num] = variants[variant]
        else:
            images[num] = variants[min(variants)]
    return images


# ------------------------------------------------------- clip 정렬

def clip_text(clip):
    parts = []
    for cap in clip.get("captions", []):
        for op in cap.get("text", []):
            parts.append(op.get("insert", ""))
    return "".join(parts)


def normalize(text):
    """공백/문장부호/유니코드 변형 제거. 비교용 축약형."""
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    return re.sub(r"[\s\.,!?\"'~…·\-—\(\)\[\]]", "", text)


def align(script, clips):
    """{번호: clip 시작 인덱스}.

    clip 경계는 대본 문장 경계와 일치하지 않는다. TTS가 문장을
    호흡 단위로 잘라 한 clip에 두 문장 끝/시작이 섞이기도 한다.
    그래서 전체 clip 자막을 하나의 문자열로 이어 붙여 문장 위치를
    찾은 뒤, 그 문자 위치가 속한 clip을 시작점으로 되돌린다.
    """
    norm = [normalize(clip_text(c)) for c in clips]
    stream = "".join(norm)

    offsets, acc = [], 0
    for text in norm:
        offsets.append(acc)
        acc += len(text)

    starts = {}
    cursor = 0
    prev_clip = -1

    for num in sorted(script):
        target = normalize(script[num])
        if not target:
            continue

        at = stream.find(target, cursor)
        if at < 0:  # 문장이 길면 앞부분만으로 다시 찾는다
            for cut in (40, 30, 20, 12):
                if len(target) <= cut:
                    continue
                at = stream.find(target[:cut], cursor)
                if at >= 0:
                    break
        if at < 0:
            raise ValueError(
                f"{num}번 문장을 자막에서 찾지 못했다: {script[num][:40]}"
            )

        idx = bisect.bisect_right(offsets, at) - 1
        # 두 문장이 한 clip에 붙어 있으면 다음 clip부터 잡는다
        if idx <= prev_clip:
            idx = prev_clip + 1
        if idx >= len(clips):
            raise ValueError(f"{num}번 문장의 clip 범위를 벗어났다")

        starts[num] = idx
        prev_clip = idx
        cursor = at + max(1, len(target) // 2)

    return starts


def build_ranges(starts, total_clips, cover_intro=False):
    """{번호: (start, end)} 빈틈 없이 연결.

    대본 1번 앞 구간은 인트로 후킹이라 본편 이미지를 깔면 안 된다.
    후킹에는 보통 따로 만든 영상을 넣으므로 기본값은 건드리지 않는다.
    cover_intro=True로 켜면 첫 이미지를 clip 0까지 끌어온다.
    마지막 이미지는 언제나 마지막 clip까지 늘린다.
    """
    nums = sorted(starts)
    ranges = {}
    for idx, num in enumerate(nums):
        start = 0 if (cover_intro and idx == 0) else starts[num]
        end = starts[nums[idx + 1]] - 1 if idx + 1 < len(nums) else total_clips - 1
        if end < start:
            raise ValueError(f"{num}번 구간이 비었다 (start={start}, end={end})")
        ranges[num] = (start, end)
    return ranges


# ------------------------------------------------------- 트랙 생성

def cover_box(img_ratio):
    """fillType=cut: 화면을 남김없이 덮는 위치/크기."""
    if img_ratio >= VIDEO_RATIO:
        height = 1.0
        width = img_ratio / VIDEO_RATIO
    else:
        width = 1.0
        height = VIDEO_RATIO / img_ratio
    return {
        "xPos": (1.0 - width) / 2,
        "yPos": (1.0 - height) / 2,
        "width": width,
        "height": height,
    }


def image_track(track_id, media_id, img_ratio, anim):
    src, dst = KENBURNS[anim]
    box = cover_box(img_ratio)
    return {
        "trackId": track_id,
        "mediaId": media_id,
        **box,
        "rotation": 0,
        "zIndex": 0,
        "type": "image",
        "originalWidthHeightRatio": img_ratio,
        "importType": "agent",
        "kenburnsAnimationInfo": {"type": anim, "from": dict(src), "to": dict(dst)},
        "editInfo": {},
        "stats": {"fillType": "cut", "isTransparent": False},
    }


def image_ratio(path):
    """Pillow 없이 JPEG/PNG 헤더에서 크기를 읽는다."""
    data = Path(path).read_bytes()
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        w = int.from_bytes(data[16:20], "big")
        h = int.from_bytes(data[20:24], "big")
        return w / h
    if data[:2] == b"\xff\xd8":
        i = 2
        while i < len(data) - 9:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            seg = int.from_bytes(data[i + 2:i + 4], "big")
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h = int.from_bytes(data[i + 5:i + 7], "big")
                w = int.from_bytes(data[i + 7:i + 9], "big")
                return w / h
            i += 2 + seg
    raise ValueError(f"이미지 크기를 못 읽었다: {path}")


def inject(project, ranges, images, rng):
    """project.json 딕셔너리에 이미지 트랙/에셋/파일 항목을 채워 넣는다."""
    clips = project["transcript"]["clips"]
    tracks = project["props"]["tracks"]
    assets = project["props"]["assets"]
    files = project["files"]

    plan = []
    for order, num in enumerate(sorted(ranges)):
        start, end = ranges[num]
        path = images[num]

        media_id = str(uuid.UUID(int=rng.getrandbits(128), version=4))
        track_id = make_id(rng)
        asset_id = str(uuid.UUID(int=rng.getrandbits(128), version=4))
        anim = ANIM_CYCLE[order % len(ANIM_CYCLE)]
        ratio = image_ratio(path)

        tracks[track_id] = image_track(track_id, media_id, ratio, anim)
        assets[asset_id] = {"trackIds": [track_id], "role": "sub"}

        files.append({
            "version": 1,
            "mediaId": media_id,
            "sourceOrigin": "LOCAL",
            "fileSize": path.stat().st_size,
            "name": f"{media_id}{path.suffix.lower()}",
            "type": "Image",
            "fileLocation": "IN_MEMORY",
        })

        # 구간 내 모든 clip에 같은 assetId를 붙여 이미지를 이어 붙인다
        for i in range(start, end + 1):
            clips[i].setdefault("assetIds", []).append(asset_id)

        plan.append({
            "num": num, "start": start, "end": end, "clips": end - start + 1,
            "anim": anim, "file": path.name,
            "media_name": f"{media_id}{path.suffix.lower()}", "path": path,
        })
    return plan


def write_vrew(src_vrew, out_vrew, project, plan):
    """원본 zip을 복사하며 project.json 교체 + 이미지 미디어 추가."""
    src_vrew, out_vrew = Path(src_vrew), Path(out_vrew)
    if out_vrew.exists():
        out_vrew.unlink()

    payload = json.dumps(project, ensure_ascii=False, separators=(",", ":"))

    with zipfile.ZipFile(src_vrew) as zin, \
         zipfile.ZipFile(out_vrew, "w", zipfile.ZIP_STORED) as zout:
        for item in zin.infolist():
            if item.filename == "project.json":
                continue
            zout.writestr(item, zin.read(item.filename))
        zout.writestr("project.json", payload.encode("utf-8"))
        for entry in plan:
            zout.writestr(f"media/{entry['media_name']}", entry["path"].read_bytes())


def run(base, vrew_name, prompts_name, image_dir, out_name,
        variant=None, seed=20260828, cover_intro=False):
    import random
    base = Path(base)
    rng = random.Random(seed)

    src_vrew = base / vrew_name
    with zipfile.ZipFile(src_vrew) as z:
        project = json.loads(z.read("project.json").decode("utf-8"))

    script = parse_script(base / prompts_name)
    images = parse_images(base / image_dir, variant=variant)

    missing = sorted(set(script) - set(images))
    if missing:
        raise ValueError(f"이미지 없는 대본 번호: {missing}")

    clips = project["transcript"]["clips"]
    starts = align(script, clips)
    ranges = build_ranges(starts, len(clips), cover_intro=cover_intro)
    plan = inject(project, ranges, images, rng)
    write_vrew(src_vrew, base / out_name, project, plan)
    return plan, len(clips)
