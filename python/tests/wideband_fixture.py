"""Small shared fixture bridge; no server, native library or solver is loaded."""
import copy
import json
from pathlib import Path
from fairbeam.design import blank_design, evaluate
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


if __name__ == "__main__":
    print(json.dumps({"cases": cases(), "blank": blank_design("wideband", "Wideband")}))
