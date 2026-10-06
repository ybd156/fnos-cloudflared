#!/usr/bin/env python3
"""Validate that each given file is parseable JSON.

fnOS reads config/privilege, config/resource, app/ui/config and the wizard
files as JSON at install time; a malformed one is rejected by the app center,
so the build checks them before packing.

Usage: validate-json.py <file> [<file> ...]
Exit:  0 all valid, 1 at least one invalid, 2 usage error.
"""

import json
import sys


def main(argv):
    if not argv:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    bad = 0
    for path in argv:
        try:
            with open(path, "r", encoding="utf-8-sig") as f:
                json.load(f)
        except Exception as exc:
            print(f"  INVALID {path}: {exc}", file=sys.stderr)
            bad += 1
    if bad:
        return 1
    print(f"  {len(argv)} JSON files OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
