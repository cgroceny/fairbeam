' Synthetic planar blade with degree-based dimensions.
StoreParameter "angle", "atnd(1)"
StoreParameter "height", "10*cosd(angle)"
With Polygon3D
 .Reset
 .Name "outline"
 .Curve "profiles"
 .Point "0", "0", "0"
 .Point "4", "0", "0"
 .Point "2+tand(angle)", "height", "0"
 .Point "0", "0", "0"
 .Create
End With
With CoverCurve
 .Reset
 .Name "radiator"
 .Component "antenna"
 .Material "PEC"
 .Curve "profiles:outline"
 .Create
End With
Solid.ThickenSheetAdvanced "antenna:radiator", "Outside", "0.2", "True"
