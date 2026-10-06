"""Small organizational metadata; never restores geometry from exported Python."""
from collections import Counter

from .legacy import organization_of
def organization_issues(d):
    out = []
    folders = d.get("components", [])
    if not isinstance(folders, list):
        out.append(("components", "components must be a list of non-empty folder paths"))
    else:
        for i, path in enumerate(folders):
            if not isinstance(path, str) or not path.strip() or any(not part.strip() for part in path.split("/")):
                out.append((f"components[{i}]", "component must be a non-empty folder path such as 'antenna/feed'"))
    parts = d.get("parts", [])
    for i, part in enumerate(parts if isinstance(parts, list) else []):
        if not isinstance(part, dict):
            continue
        path = part.get("component")
        if "component" in part and not isinstance(path, str):
            out.append((f"parts[{i}].component", "component must be a folder path such as 'antenna/feed' or empty"))
    return out

def restore_organization(module, core, part_sources=None, source_counts=None):
    """Restore folders using actual native-property provenance when readback supplies it.

    Standalone callers without provenance retain exact unique-name matching.
    Generated suffixes never identify a source property.
    """
    attr, metadata = organization_of(module)   # FAIRBEAM_ORGANIZATION, or FAIRBEAM_ORGANIZATION in an old export
    if metadata is None:
        return
    if not isinstance(metadata, dict) or not isinstance(metadata.get("parts", {}), dict):
        raise ValueError(f"{attr} must contain a parts mapping and optional components list")
    probe = {"parts": [{"component": path} for path in metadata.get("parts", {}).values()]}
    if "components" in metadata:
        probe["components"] = metadata["components"]
    issues = organization_issues(probe)
    if issues or any(not isinstance(name, str) or not name for name in metadata.get("parts", {})):
        raise ValueError(f"invalid {attr} folder metadata")
    if "components" in metadata:
        core["components"] = list(metadata["components"])
    names = Counter(part["name"] for part in core["parts"])
    for part in core["parts"]:
        name = part["name"]
        source = name if part_sources is None else part_sources.get(name)
        unique = names[name] == 1
        if part_sources is not None:
            unique = unique and source_counts is not None and source_counts.get(source, 0) == 1
        if unique and source in metadata.get("parts", {}):
            part["component"] = metadata["parts"][source]
