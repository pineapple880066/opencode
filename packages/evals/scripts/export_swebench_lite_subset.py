#!/usr/bin/env python3

import argparse
import json
import sys
from pathlib import Path


EXPORT_FIELDS = [
    "instance_id",
    "repo",
    "base_commit",
    "problem_statement",
    "hints_text",
    "version",
    "FAIL_TO_PASS",
    "PASS_TO_PASS",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="导出 SWE-bench Lite 的一个小子集，供当前仓库的 headless runner 使用。"
    )
    parser.add_argument(
        "--dataset-name",
        default="SWE-bench/SWE-bench_Lite",
        help="Hugging Face dataset 名称或本地 datasets 路径。",
    )
    parser.add_argument("--split", default="test", help="要导出的 split，默认 test。")
    parser.add_argument(
        "--count",
        type=int,
        default=5,
        help="如果未指定 instance_id，则默认导出前 N 条实例。",
    )
    parser.add_argument(
        "--instance-id",
        action="append",
        dest="instance_ids",
        default=[],
        help="显式指定 instance_id，可重复传入。",
    )
    parser.add_argument(
        "--output",
        default=".benchmarks/swebench-lite/instances.json",
        help="导出的 JSON 文件路径。",
    )
    return parser.parse_args()


def load_dataset_rows(dataset_name: str, split: str):
    try:
        from datasets import load_dataset
    except ImportError as exc:
        raise SystemExit(
            "缺少 Python 依赖 datasets。请先在 SWE-bench 或本地 venv 中执行: pip install datasets"
        ) from exc

    dataset = load_dataset(dataset_name, split=split)
    return list(dataset)


def select_rows(rows, instance_ids, count):
    if instance_ids:
      requested = set(instance_ids)
      selected = [row for row in rows if row.get("instance_id") in requested]
      found = {row.get("instance_id") for row in selected}
      missing = sorted(requested - found)
      if missing:
          raise SystemExit(f"这些 instance_id 不在数据集中: {', '.join(missing)}")
      return selected

    return rows[:count]


def main() -> int:
    args = parse_args()
    rows = load_dataset_rows(args.dataset_name, args.split)
    selected = select_rows(rows, args.instance_ids, args.count)
    exported = [
        {field: row.get(field) for field in EXPORT_FIELDS}
        for row in selected
    ]

    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(exported, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(
        json.dumps(
            {
                "dataset_name": args.dataset_name,
                "split": args.split,
                "count": len(exported),
                "output": str(output_path),
                "instance_ids": [row["instance_id"] for row in exported],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
