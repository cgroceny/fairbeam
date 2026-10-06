! Touchstone 2.0 three-port, upper-triangular matrix, per-port references 50 / 75 / 100 ohm
! (the [Reference] values continue on the next line). Renormalised to 50 ohm on reading:
! f1, three matched ports at their own references: S11 = 0, S22 = 0.2, S33 = 1/3;
! f2, an ideal match between port 1 (50) and port 2 (75): S11 = -0.2, S22 = 0.2, S21 = sqrt(0.96).
[Version] 2.0
# GHz S RI R 50
[Number of Ports] 3
[Reference] 50 75
100
[Matrix Format] Upper
[Number of Frequencies] 2
[Network Data]
1.0  0 0  0 0  0 0
          0 0  0 0
               0 0
2.0  0 0  1 0  0 0
          0 0  0 0
               0 0
[End]
