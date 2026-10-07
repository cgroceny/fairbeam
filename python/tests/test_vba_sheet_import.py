"""Synthetic VBA macro regression cases for sheets and straight lofts."""
import math
from pathlib import Path
import unittest

from fairbeam.cst_import import _Refuse, import_cst, translate
from fairbeam.design import evaluate, resolve_names, polyhedron_triangles
from fairbeam.preview import build_preview

FIXTURES = Path(__file__).parent / 'fixtures' / 'vba'


class VbaSheets(unittest.TestCase):
    def macro(self, name):
        return (FIXTURES / name).read_text()

    def parts(self, result):
        return {p['name']: p for p in result['design']['parts']}

    def test_degree_functions(self):
        for expr, value in [('sind(30)', .5), ('cosd(60)', .5), ('tand(45)', 1),
                            ('asind(0.5)', 30), ('acosd(0.5)', 60), ('atnd(1)', 45),
                            ('SiNd(-30)', -.5), ('sind(atnd(1))', math.sqrt(.5)),
                            ('2/asind(0.5)', 2/30), ('atnd(1)^2', 2025),
                            ('sin(pi/2)', 1)]:
            with self.subTest(expr=expr):
                self.assertAlmostEqual(translate(expr, {}), value)
        expr = translate('cosd(angle + 15)', {'angle': 'angle'})
        self.assertAlmostEqual(evaluate(expr, {'angle': 45}), .5)
        for expr in ['sind()', 'tand(1,2)', 'asind(2)', 'acosd(-2)']:
            with self.subTest(expr=expr), self.assertRaises(_Refuse):
                translate(expr, {})

    def test_blade_and_direction(self):
        for direction, low, high in [('Outside', 0, .2), ('Inside', -.2, 0), ('Centered', -.1, .1)]:
            with self.subTest(direction=direction):
                result = import_cst(self.macro('blade.bas').replace('"Outside"', f'"{direction}"'))
                self.assertEqual(result['report']['refused'], 0)
                p = self.parts(result)['radiator']['primitives'][0]
                self.assertEqual(p['kind'], 'linpoly')
                self.assertEqual(sorted([p['elevation'], p['elevation'] + p['length']]), [low, high])
                names = resolve_names(result['design'], {})
                self.assertAlmostEqual(evaluate(p['points'][2][1], names), 10 * math.sqrt(.5))

    def test_thickness_units_and_reversed_normal(self):
        source = self.macro('blade.bas').replace('.Point "4", "0", "0"\n .Point "2+tand(angle)", "height", "0"',
                     '.Point "2+tand(angle)", "height", "0"\n .Point "4", "0", "0"')
        result = import_cst('Units.Geometry "cm"\n' + source)
        p = self.parts(result)['radiator']['primitives'][0]
        self.assertEqual(p['length'], -2)

    def test_bad_thickness_retains_named_sheet(self):
        for direction, thickness in [('Sideways', '.2'), ('Outside', '-1'), ('Outside', 'unknown')]:
            source = self.macro('blade.bas').replace('"Outside", "0.2"', f'"{direction}", "{thickness}"')
            result = import_cst(source)
            self.assertEqual(self.parts(result)['radiator']['primitives'][0]['kind'], 'polygon')
            self.assertTrue(any('antenna:radiator' in n['message'] and n['severity'] == 'refused'
                                for n in result['report']['notes']))

    def test_extra_option_and_zero_thickness(self):
        source = self.macro('blade.bas')
        result = import_cst(source.replace('"0.2", "True"', '"0.2", "True", "extra"'))
        self.assertEqual(self.parts(result)['radiator']['primitives'][0]['kind'], 'linpoly')
        self.assertTrue(any('radiator' in n['message'] and 'additional options' in n['message']
                            for n in result['report']['notes']))
        result = import_cst(source.replace('"0.2"', '"0"'))
        self.assertEqual(self.parts(result)['radiator']['primitives'][0]['kind'], 'polygon')

    def test_straight_loft_is_closed_frustum(self):
        result = import_cst(self.macro('loft.mcs'), filename='loft.mcs')
        self.assertEqual(result['report']['refused'], 0)
        p = self.parts(result)['parasitic']['primitives'][0]
        self.assertEqual(p['kind'], 'polyhedron')
        edges = {}
        volume = 0
        for a, b, c in polyhedron_triangles(p['vertices'], p['faces']):
            for i, j in [(a,b), (b,c), (c,a)]:
                key = tuple(sorted([i,j]))
                edges[key] = edges.get(key, 0) + (1 if i < j else -1)
            u,v,w = [p['vertices'][i] for i in [a,b,c]]
            volume += (u[0]*(v[1]*w[2]-v[2]*w[1]) - u[1]*(v[0]*w[2]-v[2]*w[0])
                       + u[2]*(v[0]*w[1]-v[1]*w[0]))/6
        self.assertTrue(all(v == 0 for v in edges.values()))
        bundle = build_preview(None, {}, design=result["design"])["bundle"]
        self.assertEqual(len(bundle["parts"]), 3)
        self.assertAlmostEqual(volume, 56)  # h/3 * (16 + 4 + sqrt(16*4))

    def test_unsupported_lofts_keep_profiles_and_name_each_shape(self):
        source = self.macro('loft.mcs').replace('.Tangency "0"', '.Tangency "0.25"')
        source += '\nWith Loft\n .Name "second_element"\n .Tangency "0.25"\n .Create\nEnd With\n'
        result = import_cst(source)
        self.assertEqual(set(self.parts(result)), {'lower', 'upper'})
        notes = [n['message'] for n in result['report']['notes'] if n['severity'] == 'refused']
        self.assertTrue(any('parasitic' in n and 'retained' in n for n in notes))
        self.assertTrue(any('second_element' in n for n in notes))

    def test_unresolved_picks_do_not_create_loft(self):
        for old, new in [('"antenna:upper", "1"', '"antenna:upper", "2"'),
                         ('.Tangency "0"', '.SmoothTransition "True"'),
                         ('"antenna:upper", "1"', '"antenna:missing", "1"'),
                         ('.Point "3", "3", "6"', '.Point "4", "3", "6"')]:
            result = import_cst(self.macro('loft.mcs').replace(old, new))
            self.assertEqual(set(self.parts(result)), {'lower', 'upper'})
            self.assertTrue(any('parasitic' in n['message'] for n in result['report']['notes']))

    def test_unknown_objects_and_operations_report_every_name(self):
        source = self.macro('blade.bas')
        for name in ['first_missing', 'second_missing']:
            source += f'\nWith UnsupportedShape\n .Name "{name}"\n .Create\nEnd With\n'
            source += f'Solid.Unsupported "antenna:{name}"\n'
        result = import_cst(source)
        notes = [n['message'] + n['where'] for n in result['report']['notes'] if n['severity'] == 'refused']
        for name in ['first_missing', 'second_missing']:
            self.assertEqual(sum(name in n for n in notes), 2)

    def test_only_unsupported_shape_still_returns_named_report(self):
        result = import_cst('With UnsupportedShape\n .Name "missing_radiator"\n .Create\nEnd With')
        self.assertTrue(any('missing_radiator' in n['message'] for n in result['report']['notes']))
        result = import_cst('With Brick\n .Name "incomplete_radiator"\nEnd With')
        self.assertTrue(any('incomplete_radiator' in n['message'] for n in result['report']['notes']))

    def test_loft_axes_and_reversed_selection(self):
        import re
        for axis in range(3):
            source = self.macro('loft.mcs')
            def rotate(match):
                xyz = [match[i] for i in (1, 2, 3)]
                xyz = xyz[axis:] + xyz[:axis]
                return '.Point ' + ', '.join(f'"{v}"' for v in xyz)
            source = re.sub(r'\.Point "([^"]+)", "([^"]+)", "([^"]+)"', rotate, source)
            source = source.replace('Pick.PickFaceFromId "antenna:lower", "1"\nPick.PickFaceFromId "antenna:upper", "1"',
                                    'Pick.PickFaceFromId "antenna:upper", "1"\nPick.PickFaceFromId "antenna:lower", "1"')
            result = import_cst(source)
            self.assertEqual(result['report']['refused'], 0)
            self.assertEqual(self.parts(result)['parasitic']['primitives'][0]['kind'], 'polyhedron')

    def test_loft_does_not_reuse_cleared_picks(self):
        for command in ['Pick.ClearAllPicks', 'Pick.PickFaceFromPoint "antenna:lower", "0", "0", "0"']:
            source = self.macro('loft.mcs').replace('With Loft', command + '\nWith Loft')
            result = import_cst(source)
            self.assertNotIn('parasitic', self.parts(result))
            self.assertTrue(any('parasitic' in n['message'] and 'picked' in n['message']
                                for n in result['report']['notes']))

    def test_thickened_radiator_can_be_translated(self):
        source = self.macro('blade.bas') + '''
With Transform
 .Reset
 .Name "antenna:radiator"
 .Vector "0", "0", "5"
 .UsePickedPoints "False"
 .InvertPickedPoints "False"
 .MultipleObjects "False"
 .GroupObjects "False"
 .Repetitions "1"
 .Transform "Shape", "Translate"
End With
'''
        result = import_cst(source)
        self.assertEqual(result['report']['refused'], 0)
        self.assertTrue(self.parts(result)['radiator']['transforms'])
        self.assertEqual(len(build_preview(None, {}, design=result['design'])['bundle']['parts']), 1)
