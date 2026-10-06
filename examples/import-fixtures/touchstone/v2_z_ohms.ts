! Touchstone 2.0 one-port Z-parameters: in version 2 Z is in ohms (not normalised), and
! [Reference] overrides the option line's R. 50 ohm at 75 ohm: S11 = -0.2; 75 ohm: S11 = 0.
[Version] 2.0
# GHz Z RI R 50
[Number of Ports] 1
[Reference] 75
[Number of Frequencies] 2
[Network Data]
1.0  50 0
2.0  75 0
[End]
