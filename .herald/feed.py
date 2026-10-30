"""sitepatch feed for herald: a site broke a patch, CI repaired one, or a patch passed the by-eye audit.
Posts describe what the automated check saw; only audited patches get announced as working."""
import glob
import json
import os

ROOT = os.path.join(os.path.dirname(__file__), "..")
SITE = "https://dadwritestech.github.io/sitepatch"


def main():
    for path in sorted(glob.glob(os.path.join(ROOT, "patches", "*", "*.meta.json"))):
        m = json.load(open(path, encoding="utf-8"))
        h = m.get("history") or []
        key = f"{m['host']}/{m['slug']}"
        for prev, cur in zip(h, h[1:]):
            if cur["event"] == "retest" and prev.get("pass") and not cur.get("pass"):
                print(json.dumps({
                    "id": f"sitepatch/broke/{key}/{cur['at']}",
                    "text": (f"{m['host']} changed its page and broke the \"{m['request']}\" patch. "
                             f"Daily retest caught it; auto-repair is up next."),
                    "link": SITE, "priority": 4}, ensure_ascii=False))
            if cur["event"] == "repaired" and cur.get("pass"):
                print(json.dumps({
                    "id": f"sitepatch/repaired/{key}/{cur['at']}",
                    "text": (f"Self-heal: {m['host']} broke the \"{m['request']}\" patch, and CI rewrote it "
                             f"in {cur.get('attempts', '?')} attempt(s). Version {m.get('version')} now "
                             f"passes the retest again."),
                    "link": SITE, "priority": 5}, ensure_ascii=False))
        audit = m.get("audit") or {}
        if audit.get("correct") and m.get("status") == "pass":
            print(json.dumps({
                "id": f"sitepatch/new/{key}/{audit.get('version', m.get('version'))}",
                "text": (f"New userscript: \"{m['request']}\" on {m['host']}. Written from that one "
                         f"sentence, checked by before/after screenshots, retested daily."),
                "link": SITE, "priority": 2}, ensure_ascii=False))


if __name__ == "__main__":
    main()
