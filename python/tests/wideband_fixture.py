"""Small shared fixture bridge; no server, native library or solver is loaded."""
import copy
import json
import sys
from pathlib import Path

if __name__ == "__main__" and "fairbeam" not in sys.modules:
    # Like designer_fixture.py, load the real stdlib-only schema modules without
    # fairbeam.__init__, which eagerly imports the native simulation SDK.
    import types
    package = types.ModuleType("fairbeam")
    package.__path__ = [str(Path(__file__).resolve().parents[1] / "fairbeam")]
    sys.modules["fairbeam"] = package

from fairbeam.design import blank_design, evaluate, resolve_names
from fairbeam.design_checks import lint
from fairbeam.designer_dispersion import resolved_input


def cases():
    fixture = json.loads(Path(__file__).with_name("fixtures").joinpath("wideband_materials.json").read_text())
    output = []
    for case in fixture["cases"]:
        material = {**copy.deepcopy(fixture["base"]), **case["patch"]}
        try:
            result = {"input": resolved_input(material, lambda v: evaluate(v, fixture["names"]))}
        except ValueError as error:
            result = {"error": str(error)}
        design = blank_design("wideband", "Wideband")
        design["params"] += [{"key": k, "default": v} for k, v in fixture["names"].items() if k not in {p["key"] for p in design["params"]}]
        design["materials"].append(material)
        result["checks"] = sorted(f"{c['severity']}|{c['code']}|{c['path']}" for c in lint(design) if c["path"].startswith("materials.Laminate"))
        output.append(result)
    return output


def design_states(designs):
    """Resolve the actual post-edit designs from the pure TS lifecycle regression."""
    output = []
    for design in designs:
        names = resolve_names(design, {})
        materials = []
        for material in design["materials"]:
            if "dispersion" not in material:
                continue
            try:
                materials.append({"input": resolved_input(material, lambda v: evaluate(v, names))})
            except ValueError as error:
                materials.append({"error": str(error)})
        output.append({"materials": materials, "checks": sorted(
            f"{c['severity']}|{c['code']}|{c['path']}" for c in lint(design)
            if c["path"].startswith("materials."))})
    return output


if __name__ == "__main__":
    if "--designs" in sys.argv:
        print(json.dumps(design_states(json.load(sys.stdin))))
    else:
        print(json.dumps({"cases": cases(), "blank": blank_design("wideband", "Wideband")}))
