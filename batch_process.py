#!/usr/bin/env python3
"""
批量处理VR视频文件
自动处理指定目录下的所有MP4文件
"""
import os
import sys
import subprocess
import logging
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import time

def process_single_file(input_file: Path, output_dir: Path, segment_duration: float = 300.0, 
                       encoder: str = "libx265", quality: str = "high", max_workers: int = 2, skip_split_encode: bool = False, force_4k: bool = False):
    """处理单个视频文件"""
    # 生成输出文件名
    output_file = output_dir / f"{input_file.stem}_final_{encoder}.mp4"
    
    # 构建命令
    cmd = [
        sys.executable, "src/main.py", "split-encode-merge",
        "--input-file", str(input_file),
        "--output-file", str(output_file),
        "--segment-duration", str(segment_duration),
        "--encoder", encoder,
        "--quality", quality,
        "--max-workers", str(max_workers)
    ]
    
    # 添加跳过分割编码参数
    if skip_split_encode:
        cmd.append("--skip-split-encode")
    
    # 添加强制4K参数
    if force_4k:
        cmd.append("--force-4k")
    
    print(f"开始处理: {input_file.name}")
    print(f"输出文件: {output_file.name}")
    print(f"命令: {' '.join(cmd)}")
    print("-" * 80)
    
    try:
        # 执行命令
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        print(f"[SUCCESS] 处理完成: {input_file.name}")
        return True, input_file.name
    except subprocess.CalledProcessError as e:
        print(f"[ERROR] 处理失败: {input_file.name}")
        print(f"错误信息: {e.stderr}")
        return False, input_file.name

def batch_process(input_dir: str, output_dir: str, segment_duration: float = 300.0,
                 encoder: str = "libx265", quality: str = "high", max_workers: int = 2,
                 parallel_files: int = 1, skip_split_encode: bool = False, force_4k: bool = False):
    """批量处理目录下的所有MP4文件"""
    
    input_path = Path(input_dir)
    output_path = Path(output_dir)
    
    # 确保输出目录存在
    output_path.mkdir(parents=True, exist_ok=True)
    
    # 查找所有MP4文件
    mp4_files = list(input_path.glob("*.mp4"))
    
    if not mp4_files:
        print(f"在目录 {input_dir} 中未找到MP4文件")
        return
    
    print(f"找到 {len(mp4_files)} 个MP4文件:")
    for f in mp4_files:
        print(f"  - {f.name}")
    print()
    
    # 处理文件
    if parallel_files == 1:
        # 串行处理
        success_count = 0
        for mp4_file in mp4_files:
            success, filename = process_single_file(
                mp4_file, output_path, segment_duration, encoder, quality, max_workers, skip_split_encode, force_4k
            )
            if success:
                success_count += 1
            print()
    else:
        # 并行处理多个文件
        print(f"并行处理 {len(mp4_files)} 个文件 (并行数: {parallel_files})")
        with ThreadPoolExecutor(max_workers=parallel_files) as executor:
            futures = []
            for mp4_file in mp4_files:
                future = executor.submit(
                    process_single_file,
                    mp4_file, output_path, segment_duration, encoder, quality, max_workers, skip_split_encode, force_4k
                )
                futures.append(future)
            
            success_count = 0
            for future in as_completed(futures):
                success, filename = future.result()
                if success:
                    success_count += 1
                print()
    
    print(f"批量处理完成: {success_count}/{len(mp4_files)} 个文件处理成功")

def main():
    import argparse
    
    parser = argparse.ArgumentParser(description="批量处理VR视频文件")
    parser.add_argument("--input-dir", type=str, required=True, help="输入目录路径")
    parser.add_argument("--output-dir", type=str, required=True, help="输出目录路径")
    parser.add_argument("--segment-duration", type=float, default=300.0, help="分割时长(秒)")
    parser.add_argument("--encoder", choices=["libx265", "hevc_nvenc", "hevc_qsv"], 
                       default="libx265", help="编码器类型")
    parser.add_argument("--quality", choices=["low", "medium", "high", "ultra"], 
                       default="high", help="质量预设")
    parser.add_argument("--max-workers", type=int, default=2, help="每个文件的并发编码任务数")
    parser.add_argument("--parallel-files", type=int, default=1, help="同时处理的文件数")
    parser.add_argument("--skip-split-encode", action="store_true", help="跳过分割和编码步骤，直接合并")
    parser.add_argument("--force-4k", action="store_true", help="强制输出4K分辨率")
    
    args = parser.parse_args()
    
    # 设置日志
    logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
    
    print("批量处理VR视频文件")
    print(f"输入目录: {args.input_dir}")
    print(f"输出目录: {args.output_dir}")
    print(f"编码器: {args.encoder}")
    print(f"质量: {args.quality}")
    print(f"分割时长: {args.segment_duration}秒")
    print(f"每个文件并发数: {args.max_workers}")
    print(f"文件并行数: {args.parallel_files}")
    print(f"跳过分割编码: {args.skip_split_encode}")
    print(f"强制4K: {args.force_4k}")
    print("=" * 80)
    
    batch_process(
        args.input_dir, args.output_dir, args.segment_duration,
        args.encoder, args.quality, args.max_workers, args.parallel_files, args.skip_split_encode, args.force_4k
    )

if __name__ == "__main__":
    main() 