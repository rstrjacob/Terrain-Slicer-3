from __future__ import annotations

import argparse
import logging

import uvicorn

from .app import app

logger = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(description="Florida Mission Planner Worker")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args()

    log_level = args.log_level.upper()
    logging.basicConfig(level=getattr(logging, log_level, logging.INFO))

    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)


if __name__ == "__main__":
    main()
