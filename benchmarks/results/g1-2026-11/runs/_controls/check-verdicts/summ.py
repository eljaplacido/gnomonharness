import json, sys
v = json.load(open(sys.argv[1]))
parts = [c["id"] + "=" + c["status"] for c in v.get("checks", [])]
if v.get("error"):
    parts.append("ERROR: " + v["error"])
print(" ".join(parts))
