# -*- coding: utf-8 -*-
"""src/ 의 HTML과 JS를 index.html 하나로 합친다.

브라우저에서 file:// 로 열면 ES 모듈을 불러오지 못하므로
import/export 를 걷어내고 <script> 안에 그대로 넣는다.
"""
import re
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / 'src'

IMPORT_BLOCK = """<script type="module">
import { readZip, entryBytes, writeZip } from './vrewzip.js';
import { parseScript, parseImages, align, buildRanges, inject, imageRatio, diagnose } from './vrewcore.js';
"""


def strip_exports(text):
    return re.sub(r'^export\s+', '', text, flags=re.M)


def main():
    html = (SRC / 'index.html').read_text(encoding='utf-8')
    if IMPORT_BLOCK not in html:
        raise SystemExit('src/index.html 의 import 블록이 예상과 다릅니다')

    merged = '<script>\n'
    merged += strip_exports((SRC / 'vrewzip.js').read_text(encoding='utf-8')) + '\n'
    merged += strip_exports((SRC / 'vrewcore.js').read_text(encoding='utf-8')) + '\n'

    out = html.replace(IMPORT_BLOCK, merged)

    for leftover in ('type="module"', 'import {', '\nexport '):
        if leftover in out:
            raise SystemExit('모듈 문법이 남아 있습니다: ' + leftover.strip())

    target = ROOT / 'index.html'
    target.write_text(out, encoding='utf-8')
    print('index.html 생성 완료 (%.0f KB)' % (target.stat().st_size / 1024))


if __name__ == '__main__':
    main()
