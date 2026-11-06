"""Numeric NEC transfer controls: no solver execution."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fairbeam import nec

from fairbeam import nec_import as module
parse_deck = module.parse_deck


class ImportControls(unittest.TestCase):
    def setUp(self):
        self.model = nec.dipole(475, .05, 31, [.29, .30, .31], 75)
        self.text = nec.deck(self.model)

    def test_own_numeric_exports_round_trip_geometry_feed_and_frequencies(self):
        for pattern in (False, True):
            with self.subTest(pattern=pattern), patch.object(nec, 'solve', side_effect=AssertionError('No solve')):
                result = parse_deck(nec.deck(self.model, pattern=pattern), reference_ohm=75)
                expected = copy.deepcopy(self.model)
                expected['name'] = 'Imported NEC wire model'
                self.assertEqual(result['model'], expected)
                self.assertEqual(result['pattern'], pattern)
                self.assertFalse(result['report']['solver_run'])
                self.assertFalse(result['report']['numerically_validated'])
                self.assertFalse(result['report']['unsupported_cards_discarded'])

    def test_linear_frequency_sweep_converts_mhz_to_ghz(self):
        start = self.text.index('FR ')
        result = parse_deck(self.text[:start]+'FR 0 3 0 0 290 10\nXQ 0\nEN\n')
        self.assertEqual(result['model']['frequency_ghz'], [.29, .30, .31])
        self.assertEqual(result['model']['reference_ohm'], 50)

    def test_numeric_fields_and_card_boundaries_use_nec_ascii_syntax(self):
        for source in (self.text.replace('GE 0', 'GE ٠'),
                       self.text.replace('GE 0', 'GE\u00a00'),
                       self.text.replace('GE 0', '\u00a0GE 0'),
                       self.text.replace('GE 0\n', 'GE 0\u2028'),
                       self.text.replace('GE 0\n', 'GE 0\x85')):
            with self.subTest(source=source), self.assertRaises(ValueError):
                parse_deck(source)

    def test_reference_resistance_is_an_explicit_import_setting(self):
        self.assertEqual(parse_deck(self.text, reference_ohm=123)['model']['reference_ohm'], 123)
        for bad in (True, 0, -1, float('nan'), float('inf'), 10**400):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                parse_deck(self.text, reference_ohm=bad)

    def test_export_rejects_collapsed_numeric_geometry_and_frequency(self):
        tiny_radius = nec.dipole(475, 5e-324, 31, [.3])
        short = {"schema": nec.SCHEMA, "wires": [{"tag": 1, "segments": 1,
            "start_mm": [1e8, 0, 0], "end_mm": [1e8+.00001, 0, 0], "radius_mm": 1e-7}],
            "feed": {"tag": 1, "segment": 1}, "frequency_ghz": [.3], "reference_ohm": 50}
        frequencies = nec.dipole(475, .05, 31, [.3, .30000000000001])
        for model in (tiny_radius, short, frequencies):
            nec.validate(model)  # valid before decimal serialization
            with self.subTest(model=model), self.assertRaises(ValueError):
                nec.deck(model)

    def test_export_cannot_turn_a_detached_wire_into_a_connected_junction(self):
        model = {"schema": nec.SCHEMA, "wires": [
            {"tag": 1, "segments": 1, "start_mm": [1e8-1, 0, 0], "end_mm": [1e8, 0, 0], "radius_mm": 1e-7},
            {"tag": 2, "segments": 1, "start_mm": [1e8+.00001, 0, 0], "end_mm": [1e8+.00001, 1, 0], "radius_mm": 1e-7}],
            "feed": {"tag": 1, "segment": 1}, "frequency_ghz": [.3], "reference_ohm": 50}
        nec.validate(model)
        with self.assertRaisesRegex(ValueError, "endpoint connections"):
            nec.deck(model)

    def test_unrecognized_physics_or_executable_cards_are_rejected(self):
        for card in ('LD 5 1 0 0 58000000', 'GN 1', 'GS 0 0 .5', 'GM 0 1 0 0 0 0 0 1',
                     'SY length=.5', 'IN model.nec', 'GF 0', 'NX', 'NE 0 1 1 1 0 0 0 0 0 0',
                     'TL 1 1 2 1 50 .1', 'SP 0 0 0 0 1', 'EK -1'):
            with self.subTest(card=card), self.assertRaisesRegex(ValueError, 'NEC line'):
                parse_deck(self.text.replace('EX 0', card+'\nEX 0'))

    def test_no_silent_source_kernel_or_ground_default(self):
        for old, new in [('GE 0', 'GE 1'), ('GN -1\n', ''), ('EK 0\n', ''),
                         ('EX 0 1 16 0 1 0', 'EX 0 1 16 0 2 0'),
                         ('EX 0 1 16 0 1 0', 'EX 5 1 16 0 1 0'),
                         ('EX 0 1 16 0 1 0', 'EX 0 1 16 1 1 0')]:
            with self.subTest(old=old, new=new), self.assertRaises(ValueError):
                parse_deck(self.text.replace(old, new))

    def test_order_and_execution_state_are_preserved(self):
        invalid = [self.text.replace('GE 0\n', ''), self.text.replace('XQ 0\n', '', 1),
                   self.text.replace('EX 0', 'GE 0\nEX 0'), self.text.replace('FR 0', 'EX 0 1 16 0 1 0\nFR 0', 1),
                   self.text+'GW 2 31 1 0 0 1 0 .475 .00005\n', self.text.replace('EN\n', ''),
                   self.text.replace('XQ 0', 'XQ 0\nGN -1', 1), self.text.replace('CE\n', ''),
                   self.text.replace('FR 0 1 0 0 290 0', 'FR 0 1 0 0 290 0\nFR 0 1 0 0 290 0'),
                   self.text.replace('XQ 0', 'RP 0 19 37 1000 0 0 10 10 0 0', 1)]
        for text in invalid:
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_deck(text)

    def test_counts_numbers_and_native_geometry_limits_remain_enforced(self):
        for old, new in [('GW 1 31', 'GW 1 400'), ('GW 1 31', 'GW 1.0 31'),
                         ('GW 1 31', 'GW 1 2'), ('5e-05', '0.02'),
                         ('290 0', 'NaN 0'), ('290 0', '1e999 0'),
                         ('FR 0 1', 'FR 0 82'), ('FR 0 1', 'FR 1 1'),
                         ('FR 0 1', 'FR 0 0'), ('300 0', '280 0')]:
            with self.subTest(old=old,new=new), self.assertRaises(ValueError):
                parse_deck(self.text.replace(old, new))

    def test_unknown_columns_or_missing_comma_fields_are_not_shifted(self):
        for old,new in [('GE 0', 'GE 0 0'), ('GW 1 31', 'GW 1,,31'), ('EN', 'EN 0'),
                        ('290 0', '290 0 1'), ('EX 0 1 16 0 1 0', 'EX 0 1 16 0 1 0 50')]:
            with self.subTest(new=new), self.assertRaises(ValueError):
                parse_deck(self.text.replace(old,new))

    def test_crlf_case_and_fortran_exponents_are_numeric_not_expressions(self):
        result = parse_deck('\ufeff'+self.text.lower().replace('290 0', '2.9D2 0').replace('\n', '\r\n'))
        self.assertEqual(result['model']['frequency_ghz'], [.29,.30,.31])

    def test_bounded_input(self):
        for source in (None, b'EN', '', '\x00', 'CM '+('x'*513), 'CM x\n'*4097, 'x'*(1024*1024+1),
                       '\ud800', 'CM '+('é'*512)+'\n'+self.text):
            with self.subTest(size=len(source) if source is not None else None), self.assertRaises(ValueError):
                parse_deck(source)

    def test_file_capture_preserves_source_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(nec, 'solve', side_effect=AssertionError('No solve')):
            root = Path(temp)
            source = root/'source.nec'
            raw = ('\ufeff'+self.text.replace('\n','\r\n')).encode('utf-8')
            source.write_bytes(raw)
            out = root/'imported'
            result = module.import_file(source, out, reference_ohm=75)
            self.assertEqual((out/'source.nec').read_bytes(), raw)
            self.assertEqual(result['report']['source_sha256'], hashlib.sha256(raw).hexdigest())
            self.assertEqual(json.loads((out/'model.json').read_text()), result['model'])
            before = {p.name:p.read_bytes() for p in out.iterdir()}
            with self.assertRaises(FileExistsError):
                module.import_file(source, out)
            self.assertEqual(before, {p.name:p.read_bytes() for p in out.iterdir()})
            source.write_text(self.text.replace('GN -1','GN 1'))
            with self.assertRaises(ValueError):
                module.import_file(source, root/'bad')
            self.assertFalse((root/'bad').exists())

    def test_file_reader_rejects_oversize_and_invalid_utf8(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'source.nec'
            for raw in (b'\xff', b'x'*(module.MAX_BYTES+1)):
                path.write_bytes(raw)
                with self.assertRaises(ValueError):
                    module.read_deck(path)


if __name__ == '__main__':
    unittest.main()

