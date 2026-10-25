"""Far-field angular sampling policy (degrees); no solver or native dependencies."""
import math

PATTERN_STEP_MIN = 0.25
PATTERN_STEP_MAX = 90.0


def pattern_steps(theta=3.0, phi=5.0) -> tuple[float, float]:
    """Bound the post-processing grid; these limits are policy, not physical accuracy."""
    out = []
    for axis, value in (("theta", theta), ("phi", phi)):
        if (isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(value) or not PATTERN_STEP_MIN <= value <= PATTERN_STEP_MAX):
            raise ValueError(f"{axis} angular step must be from {PATTERN_STEP_MIN:g} to {PATTERN_STEP_MAX:g} degrees")
        out.append(float(value))
    return tuple(out)


def angular_grid(theta_step=3.0, phi_step=5.0):
    """Include both theta poles, exclude the duplicate phi seam. A final interval may be shorter."""
    import numpy as np

    theta_step, phi_step = pattern_steps(theta_step, phi_step)
    theta = np.arange(0.0, 180.0, theta_step)
    phi = np.arange(0.0, 360.0, phi_step)
    return np.r_[theta[theta < 180.0 - 1e-9], 180.0], phi[phi < 360.0 - 1e-9]
