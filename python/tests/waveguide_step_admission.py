"""Pure admission rules shared by raw MUR records and reduced-data replay.

These software checks do not turn a reduced historical record into raw replay.
"""
import math
import re
from numbers import Integral, Real

MUR_PROTOCOL = 'te10-mur-control-v2'
WORKER_PROTOCOL = 'te10-mur-worker-v2'
LOG_CONTRACT = 'fairbeam-te10-mur-native-log-v1'
NATIVE_BEGIN = 'FAIRBEAM_TE10_MUR_NATIVE_BEGIN_v1'
NATIVE_END = 'FAIRBEAM_TE10_MUR_NATIVE_END_v1'


def finite_real(value):
    return isinstance(value, Real) and not isinstance(value, bool) and math.isfinite(value)


def positive_integer(value):
    return isinstance(value, Integral) and not isinstance(value, bool) and value > 0


def checked_trace(trace, timesteps):
    """Validate every observation before selecting late rows; never deduplicate."""
    if not positive_integer(timesteps) or not isinstance(trace, list):
        raise ValueError('energy trace requires an integer native allocation and a row list')
    previous = 0
    for row in trace:
        if not isinstance(row, dict):
            raise ValueError('energy trace requires timestamp/energy rows')
        step, energy = row.get('timestep'), row.get('db')
        if (not positive_integer(step) or not previous < step <= timesteps
                or not finite_real(energy)):
            raise ValueError('energy trace requires finite energies and distinct increasing in-allocation integer timesteps')
        previous = step
    return trace


def late_energies(trace, timesteps, dt_s, after_s):
    if not finite_real(dt_s) or dt_s <= 0 or not finite_real(after_s) or after_s < 0:
        raise ValueError('finite positive native clock and finite primary duration required')
    return [r['db'] for r in checked_trace(trace, timesteps) if r['timestep']*dt_s > after_s]


def checked_native_trace(text, trace, timesteps):
    """The general parser accepts integer prefixes; raw admission must not."""
    checked_trace(trace, timesteps)
    steps = []
    for line in text.splitlines():
        if 'Timestep:' not in line and 'Energy:' not in line:
            continue
        # Native output may start with [@ 4s] and has whitespace/comma delimiters.
        match = re.search(r'Timestep:[ \t]+([^\s,]+)(?=[ \t]|,[ \t]|$)', line)
        if (line.count('Timestep:') != 1 or line.count('Energy:') != 1 or match is None
                or re.fullmatch(r'[0-9]+', match[1]) is None):
            raise ValueError('native energy observation requires a complete integer timestep token')
        steps.append(int(match[1]))
    if steps != [row['timestep'] for row in trace]:
        raise ValueError('native energy observations do not match the parsed trace')
    return trace


def checked_native_grid(text, grid):
    tokens = re.findall(r'FDTD simulation size:[ \t]+([^\s]+)', text)
    if len(tokens) != 1 or re.fullmatch(r'[0-9]+x[0-9]+x[0-9]+', tokens[0]) is None:
        raise ValueError('native grid requires three complete integer dimension tokens')
    if [int(value) for value in tokens[0].split('x')] != grid:
        raise ValueError('native grid token does not match the parsed grid')


def native_log_frame(text):
    """Exclude final JSON (which repeats log_tail); reject ambiguous framing."""
    lines = text.splitlines()
    if (text.count(NATIVE_BEGIN) != 1 or text.count(NATIVE_END) != 1
            or lines.count(NATIVE_BEGIN) != 1 or lines.count(NATIVE_END) != 1):
        raise ValueError('exactly one complete native log frame required')
    start, end = lines.index(NATIVE_BEGIN), lines.index(NATIVE_END)
    if end <= start+1:
        raise ValueError('native log frame is empty or reversed')
    return '\n'.join(lines[start+1:end])
