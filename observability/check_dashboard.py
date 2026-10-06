"""Checks the Grafana dashboard: valid JSON, a stable UID, and every metric it queries is one
the services actually export (so a renamed metric breaks CI, not a panel nobody looks at)."""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DASHBOARD = ROOT / "observability/grafana/dashboards/forge-overview.json"
SOURCES = [
    ROOT / "apps/api/src/observability/metrics.ts",
    ROOT / "apps/ai-service/app/core/metrics.py",
]
# Exported by the client libraries' default collectors.
RUNTIME = {"process_resident_memory_bytes", "process_cpu_seconds_total", "nodejs_eventloop_lag_p99_seconds"}

dashboard = json.loads(DASHBOARD.read_text())
assert dashboard["uid"] == "forge-overview", "the dashboard UID is linked from the docs"

defined = set(RUNTIME)
for source in SOURCES:
    defined |= set(re.findall(r"""['"](forge_[a-z_]+)['"]""", source.read_text()))

queried = set()
for panel in dashboard["panels"]:
    for target in panel.get("targets", []):
        for name in re.findall(r"\b(forge_[a-z_]+|process_[a-z_]+|nodejs_[a-z0-9_]+)\b", target["expr"]):
            queried.add(re.sub(r"_(bucket|count|sum)$", "", name))

missing = sorted(queried - defined)
if missing:
    sys.exit(f"The dashboard queries metrics no service exports: {', '.join(missing)}")
print(f"{len(dashboard['panels'])} panels, {len(queried)} metrics, all exported")
