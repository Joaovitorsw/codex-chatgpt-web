"""Read-only PNG/grid validator. Exit: 0 valid, 1 invalid, 2 invocation/dependency."""
import argparse
import json
from pathlib import Path
import sys
import warnings


MAX_CELLS = 16384
MAX_ERRORS = 32
NOTICE = ('Visual quality, baselines, text removal, animation uniqueness and tile seam '
          'quality are outside this validator; visual/animation/seam checks remain required.')


class InvocationError(Exception):
    """Invalid CLI arguments or unreadable manifest input."""


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise InvocationError(message)


def integer(value, minimum):
    return type(value) is int and value >= minimum


def vector(value, length, minimum):
    return (isinstance(value, list) and len(value) == length
            and all(integer(item, minimum) for item in value))


def layout(spec):
    """Validate schema before allocating a bounded list of occupied cells."""
    if not isinstance(spec, dict):
        raise ValueError('Manifest must be a JSON object.')
    kind = spec.get('kind')
    if kind not in ('spritesheet', 'tilesheet'):
        raise ValueError('kind must be spritesheet or tilesheet.')
    for key in ('cell_size', 'grid'):
        if not vector(spec.get(key), 2, 1):
            raise ValueError(key + ' must contain two positive integers (not bool).')
    columns, rows = spec['grid']
    if columns * rows > MAX_CELLS:
        raise ValueError('grid must contain at most 16384 cells.')
    margins = spec.get('margins', [0, 0, 0, 0])
    spacing = spec.get('spacing', [0, 0])
    if not vector(margins, 4, 0) or not vector(spacing, 2, 0):
        raise ValueError('margins/spacing must contain four/two nonnegative integers.')
    for key in ('transparent_background', 'binary_alpha'):
        if key in spec and type(spec[key]) is not bool:
            raise ValueError(key + ' must be boolean.')
    occupied = spec.get('occupied_cells')
    if 'occupied_cells' not in spec:
        occupied = [[x, y] for y in range(rows) for x in range(columns)]
    if not isinstance(occupied, list) or not 1 <= len(occupied) <= columns * rows:
        raise ValueError('occupied_cells must be a nonempty bounded list.')
    seen = set()
    for cell in occupied:
        if not vector(cell, 2, 0) or cell[0] >= columns or cell[1] >= rows:
            raise ValueError('occupied_cells contains an invalid/out-of-range cell.')
        coordinate = tuple(cell)
        if coordinate in seen:
            raise ValueError('occupied_cells contains duplicate cells.')
        seen.add(coordinate)
    return margins, spacing, occupied


def inspect_image(image, spec, report):
    margins, spacing, occupied = layout(spec)
    width, height = spec['cell_size']
    columns, rows = spec['grid']
    left, top, right, bottom = margins
    gap_x, gap_y = spacing
    expected = (left + columns * width + (columns - 1) * gap_x + right,
                top + rows * height + (rows - 1) * gap_y + bottom)
    if image.size != expected:
        raise ValueError('Image dimensions do not match manifest grid/margins/spacing.')
    alpha = image.convert('RGBA').getchannel('A')
    histogram = alpha.histogram()
    transparent = spec.get('transparent_background', spec['kind'] == 'spritesheet')
    binary = spec.get('binary_alpha', spec['kind'] == 'spritesheet')
    if transparent and not histogram[0]:
        report['errors'].append('Transparent background requires at least one alpha=0 pixel.')
    if not any(histogram[1:]):
        report['errors'].append('Image must contain visible pixels (alpha>0).')
    if binary and any(histogram[1:255]):
        report['errors'].append('binary_alpha rejects alpha values 1..254.')
    missing = 0
    for column, row in occupied:
        x = left + column * (width + gap_x)
        y = top + row * (height + gap_y)
        report['cells_checked'] += 1
        if alpha.crop((x, y, x + width, y + height)).getextrema()[1] == 0:
            missing += 1
            if len(report['errors']) < MAX_ERRORS - 1:
                report['errors'].append(f'Required occupied cell [{column},{row}] has no visible pixels.')
    if missing:
        report['errors'].append(f'{missing} required occupied cells are empty; detail capped at 31 errors.')


def main(argv=None):
    report = {'passed': False, 'errors': [], 'warnings': [NOTICE],
              'image_size': None, 'cells_checked': 0}
    status = 1
    try:
        parser = Parser(
            description=__doc__,
            formatter_class=argparse.RawDescriptionHelpFormatter,
            epilog=(
                'Manifest JSON fields:\n'
                '  Required: kind (spritesheet|tilesheet), cell_size [w,h],\n'
                '            grid [columns,rows]; positive integers, at most 16384 cells.\n'
                '  Optional: margins [left,top,right,bottom] (default [0,0,0,0]),\n'
                '            spacing [x,y] (default [0,0]); nonnegative integers.\n'
                '            occupied_cells [[col,row],...] (default all cells);\n'
                '            nonempty, unique, zero-based and in bounds.\n'
                '            transparent_background, binary_alpha (booleans);\n'
                '            default true for spritesheet, false for tilesheet.\n\n'
                'Structural-only: checks dimensions, occupied cells and alpha.\n'
                + NOTICE + '\n'
                'Validation and invocation errors emit bounded JSON; --help emits text\n'
                'and exits 0 without opening inputs or requiring Pillow. No file writes.'
            ))
        parser.add_argument('--image', required=True, metavar='ABS_PNG',
                            help='Absolute path to the input PNG (read-only).')
        parser.add_argument('--manifest', required=True, metavar='ABS_JSON',
                            help='Absolute path to the manifest JSON (read-only).')
        args = parser.parse_args(argv)
        image_path, manifest_path = Path(args.image), Path(args.manifest)
        if not image_path.is_absolute() or not manifest_path.is_absolute():
            raise InvocationError('Image and manifest paths must be absolute.')
        try:
            from PIL import Image, UnidentifiedImageError
        except ImportError as exc:
            raise InvocationError('Pillow is required.') from exc
        try:
            # Bound input size as well as output; do not echo supplied contents.
            with manifest_path.open('r', encoding='utf-8-sig') as source:
                content = source.read(2_000_001)
            if len(content) > 2_000_000:
                raise InvocationError('Manifest exceeds 2000000 characters.')
            spec = json.loads(content)
        except (OSError, UnicodeError, json.JSONDecodeError, RecursionError) as exc:
            raise InvocationError('Manifest must be readable valid JSON.') from exc
        layout(spec)
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(image_path) as image:
                    if image.format != 'PNG':
                        raise ValueError('Input image must be PNG.')
                    report['image_size'] = list(image.size)
                    image.load()
                    inspect_image(image, spec, report)
        except (OSError, UnidentifiedImageError, Image.DecompressionBombError,
                Image.DecompressionBombWarning, SyntaxError) as exc:
            raise ValueError('Input PNG is unreadable, corrupt or exceeds the safe image limit.') from exc
        report['passed'] = not report['errors']
        status = 0 if report['passed'] else 1
    except InvocationError as exc:
        report['errors'].append(str(exc)[:300])
        status = 2
    except (ValueError, OverflowError) as exc:
        report['errors'].append(str(exc)[:300])
    print(json.dumps(report, separators=(',', ':'), ensure_ascii=True))
    return status


if __name__ == '__main__':
    sys.exit(main())
