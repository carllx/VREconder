#!/usr/bin/env python3
"""
DASH Merger - 跨平台DASH视频分段合并工具
合并.m4s文件为完整的MP4视频

功能:
- 单文件夹处理
- 批量处理
- 跨平台支持
- 音频流修复
- 错误处理和重试
"""

import os
import re
import shutil
import subprocess
import tempfile
import logging
from pathlib import Path
from typing import List, Dict, Optional, Tuple
import time

class DashMerger:
    """DASH视频分段合并器"""
    
    def __init__(self, verbose: bool = False):
        self.verbose = verbose
        self.logger = self._setup_logging()
        self.temp_dirs = []  # 用于清理
    
    def _setup_logging(self) -> logging.Logger:
        """设置日志"""
        logger = logging.getLogger(__name__)
        if not logger.handlers:
            level = logging.DEBUG if self.verbose else logging.INFO
            handler = logging.StreamHandler()
            formatter = logging.Formatter('%(asctime)s [%(levelname)s] %(message)s')
            handler.setFormatter(formatter)
            logger.addHandler(handler)
            logger.setLevel(level)
        return logger
    
    def check_dependencies(self) -> bool:
        """检查依赖工具"""
        try:
            subprocess.run(['ffmpeg', '-version'], capture_output=True, check=True)
            self.logger.debug("FFmpeg found")
            return True
        except (subprocess.CalledProcessError, FileNotFoundError):
            self.logger.error("FFmpeg not found. Please install FFmpeg")
            return False
    
    def parse_m4s_filename(self, filename: str) -> Optional[Dict[str, str]]:
        """解析m4s文件名格式: P<identifier>-<start>-<end>-<sequenceNumber>.m4s
        
        兼容Segment2Motrix.js输出格式:
        P${i+1}-${segmentPartStart.toFixed(3)}-${segmentPartEnd.toFixed(3)}-${sequenceNumber}.m4s
        """
        # 匹配格式：P1-450.056-792.500-0001.m4s
        pattern = r'^P(\d+)-(\d+\.?\d*)-(\d+\.?\d*)-(\d+)\.m4s$'
        match = re.match(pattern, filename)
        if match:
            return {
                'identifier': match.group(1),    # P后的数字 (段落标识符)
                'start': match.group(2),         # 开始时间
                'end': match.group(3),           # 结束时间  
                'sequence': match.group(4)       # 序列号
            }
        return None
    
    def get_duration(self, start: str, end: str) -> float:
        """计算时长"""
        return float(end) - float(start)
    
    def validate_file_sequence(self, files: List[Path]) -> bool:
        """验证文件序列的正确性"""
        if len(files) <= 1:
            return True
            
        prev_info = None
        for file_path in files:
            file_info = self.parse_m4s_filename(file_path.name)
            if not file_info:
                self.logger.warning(f"Cannot parse filename: {file_path.name}")
                continue
                
            if prev_info:
                prev_start = float(prev_info['start'])
                prev_sequence = int(prev_info['sequence'])
                curr_start = float(file_info['start'])
                curr_sequence = int(file_info['sequence'])
                
                # 检查时间顺序
                if curr_start < prev_start:
                    self.logger.warning(f"Time sequence error: {file_path.name} (start={curr_start}) comes after a later timestamp")
                    return False
                
                # 检查序列号（在同一时间段内应该递增）
                if curr_start == prev_start and curr_sequence <= prev_sequence:
                    self.logger.warning(f"Sequence number error: {file_path.name} (seq={curr_sequence}) should be > {prev_sequence}")
                    return False
            
            prev_info = file_info
        
        return True
    
    def find_m4s_files(self, folder_path: Path) -> Dict[str, List[Path]]:
        """查找并按identifier分组m4s文件"""
        m4s_files = {}
        
        for file_path in folder_path.glob("*.m4s"):
            file_info = self.parse_m4s_filename(file_path.name)
            if file_info:
                identifier = file_info['identifier']
                if identifier not in m4s_files:
                    m4s_files[identifier] = []
                m4s_files[identifier].append(file_path)
        
        # 按正确顺序排序：先按开始时间，再按序列号
        for identifier in m4s_files:
            def sort_key(file_path):
                file_info = self.parse_m4s_filename(file_path.name)
                if file_info:
                    # 先按开始时间排序，再按序列号排序
                    start_time = float(file_info['start'])
                    sequence_num = int(file_info['sequence'])
                    return (start_time, sequence_num)
                return (0, 0)  # 如果解析失败，放在最前面
            
            m4s_files[identifier].sort(key=sort_key)
        
        return m4s_files
    
    def merge_binary_files(self, target_file: Path, source_file: Path, max_retries: int = 3) -> bool:
        """二进制文件合并（带重试机制）"""
        for attempt in range(max_retries):
            try:
                # 检查源文件
                if not source_file.exists() or not source_file.is_file():
                    self.logger.error(f"Source file not found: {source_file}")
                    return False
                
                # 合并文件
                with open(source_file, 'rb') as src:
                    mode = 'ab' if target_file.exists() else 'wb'
                    with open(target_file, mode) as dst:
                        shutil.copyfileobj(src, dst)
                
                self.logger.debug(f"Merged: {source_file.name} -> {target_file.name}")
                return True
                
            except (IOError, OSError) as e:
                self.logger.warning(f"Merge attempt {attempt + 1} failed: {e}")
                if attempt < max_retries - 1:
                    time.sleep(0.2)
                else:
                    self.logger.error(f"Failed to merge after {max_retries} attempts")
                    return False
        
        return False
    
    def repair_audio_stream(self, input_file: Path, output_file: Path, duration: float) -> bool:
        """音频流修复（多策略尝试）"""
        strategies = [
            {
                'name': 'basic_copy',
                'args': [
                    '-f', 'mp4',
                    '-i', str(input_file),
                    '-c', 'copy',
                    '-avoid_negative_ts', 'make_zero',
                    '-fflags', '+genpts',
                    '-movflags', '+faststart',
                    '-y', str(output_file)
                ]
            },
            {
                'name': 'simple_remux',
                'args': [
                    '-i', str(input_file),
                    '-c', 'copy',
                    '-movflags', '+faststart',
                    '-y', str(output_file)
                ]
            },
            {
                'name': 'audio_resync',
                'args': [
                    '-i', str(input_file),
                    '-c:v', 'copy',
                    '-c:a', 'aac',
                    '-b:a', '128k',
                    '-af', 'aresample=async=1',
                    '-avoid_negative_ts', 'make_zero',
                    '-y', str(output_file)
                ]
            },
            {
                'name': 'force_duration',
                'args': [
                    '-i', str(input_file),
                    '-c', 'copy',
                    '-t', str(duration),
                    '-avoid_negative_ts', 'make_zero',
                    '-y', str(output_file)
                ]
            },
            {
                'name': 'full_transcode',
                'args': [
                    '-i', str(input_file),
                    '-c:v', 'libx264',
                    '-c:a', 'aac',
                    '-b:a', '128k',
                    '-avoid_negative_ts', 'make_zero',
                    '-y', str(output_file)
                ]
            }
        ]
        
        for strategy in strategies:
            self.logger.debug(f"Trying strategy: {strategy['name']}")
            try:
                cmd = ['ffmpeg'] + strategy['args']
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=300  # 5分钟超时
                )
                
                if result.returncode == 0 and output_file.exists() and output_file.stat().st_size > 0:
                    self.logger.debug(f"Strategy '{strategy['name']}' succeeded")
                    return True
                else:
                    self.logger.debug(f"Strategy '{strategy['name']}' failed with return code {result.returncode}")
                    if result.stderr:
                        self.logger.debug(f"FFmpeg stderr: {result.stderr[:500]}")  # 只显示前500字符
                    if output_file.exists():
                        output_file.unlink()
                        
            except subprocess.TimeoutExpired:
                self.logger.warning(f"Strategy '{strategy['name']}' timed out")
                if output_file.exists():
                    output_file.unlink()
            except Exception as e:
                self.logger.warning(f"Strategy '{strategy['name']}' error: {e}")
                if output_file.exists():
                    output_file.unlink()
        
        self.logger.error("All repair strategies failed")
        return False
    
    def merge_single_folder(self, folder_path: Path, output_file: Optional[Path] = None, dry_run: bool = False) -> bool:
        """合并单个文件夹中的DASH分段"""
        if not folder_path.exists() or not folder_path.is_dir():
            self.logger.error(f"Folder does not exist: {folder_path}")
            return False
        
        self.logger.info(f"Processing folder: {folder_path}")
        
        # 查找m4s文件
        m4s_groups = self.find_m4s_files(folder_path)
        if not m4s_groups:
            self.logger.warning(f"No valid m4s files found in {folder_path}")
            return False
        
        self.logger.info(f"Found {len(m4s_groups)} groups of m4s files")
        
        # 创建临时目录
        temp_dir = Path(tempfile.mkdtemp(prefix="dash_merge_"))
        self.temp_dirs.append(temp_dir)
        
        try:
            # 为每个identifier处理文件
            processed_files = []
            
            for identifier, files in m4s_groups.items():
                self.logger.info(f"Processing group P{identifier} ({len(files)} files)")
                
                # 验证文件序列
                if not self.validate_file_sequence(files):
                    self.logger.error(f"File sequence validation failed for group P{identifier}")
                    return False
                
                # 显示文件处理顺序
                if self.verbose:
                    self.logger.debug(f"File processing order for group P{identifier}:")
                    for i, file_path in enumerate(files):
                        file_info = self.parse_m4s_filename(file_path.name)
                        if file_info:
                            self.logger.debug(f"  {i+1:3d}. {file_path.name} (start={file_info['start']}, seq={file_info['sequence']})")
                        else:
                            self.logger.debug(f"  {i+1:3d}. {file_path.name} (parsing failed)")
                
                if dry_run:
                    self.logger.info(f"[DRY RUN] Would process {len(files)} files for identifier P{identifier}")
                    continue
                
                # 检查是否有init文件
                init_file = folder_path / "init.mp4"
                temp_merged = temp_dir / f"merged_{identifier}.m4s"
                
                # 如果有init文件，先复制init文件作为基础
                if init_file.exists():
                    self.logger.debug(f"Found init file, using as base for P{identifier}")
                    shutil.copy2(init_file, temp_merged)
                
                # 合并所有m4s文件
                for file_path in files:
                    if not self.merge_binary_files(temp_merged, file_path):
                        self.logger.error(f"Failed to merge file: {file_path}")
                        return False
                
                # 检查合并后的文件
                if not temp_merged.exists() or temp_merged.stat().st_size == 0:
                    self.logger.error(f"Merged file is empty or missing: {temp_merged}")
                    return False
                
                self.logger.debug(f"Merged file size for P{identifier}: {temp_merged.stat().st_size / (1024*1024):.1f} MB")
                
                # 计算总时长（使用第一个和最后一个文件的时间差）
                first_info = self.parse_m4s_filename(files[0].name)
                last_info = self.parse_m4s_filename(files[-1].name)
                
                if first_info and last_info:
                    # 简单计算：最后的结束时间 - 第一个的开始时间
                    start_time = float(first_info['start'])
                    end_time = float(last_info['end'])
                    duration = end_time - start_time
                    
                    self.logger.debug(f"Calculated duration for P{identifier}: {start_time:.3f}s - {end_time:.3f}s = {duration:.3f}s")
                else:
                    # 如果解析失败，使用默认时长
                    duration = 300.0  # 5分钟默认
                    self.logger.warning(f"Could not parse timing info for P{identifier}, using default duration {duration}s")
                
                # 修复音频流
                temp_repaired = temp_dir / f"repaired_{identifier}.mp4"
                if not self.repair_audio_stream(temp_merged, temp_repaired, duration):
                    self.logger.error(f"Failed to repair audio for identifier {identifier}")
                    return False
                
                processed_files.append(temp_repaired)
            
            if dry_run:
                self.logger.info("[DRY RUN] Processing complete")
                return True
            
            # 最终合并
            if not output_file:
                output_file = folder_path / f"{folder_path.name}.mp4"
            
            if len(processed_files) == 1:
                # 只有一个文件，直接移动
                shutil.move(str(processed_files[0]), str(output_file))
            else:
                # 多个文件，使用ffmpeg concat
                concat_file = temp_dir / "concat.txt"
                with open(concat_file, 'w') as f:
                    for file_path in processed_files:
                        f.write(f"file '{file_path.absolute()}'\n")
                
                cmd = [
                    'ffmpeg',
                    '-f', 'concat',
                    '-safe', '0',
                    '-i', str(concat_file),
                    '-c', 'copy',
                    '-y', str(output_file)
                ]
                
                result = subprocess.run(cmd, capture_output=True, text=True)
                if result.returncode != 0:
                    self.logger.error(f"Final merge failed: {result.stderr}")
                    return False
            
            self.logger.info(f"Successfully merged to: {output_file}")
            return True
            
        except Exception as e:
            self.logger.error(f"Merge failed: {e}")
            return False
        finally:
            # 清理临时文件
            self._cleanup_temp_dir(temp_dir)
    
    def merge_batch(self, parent_dir: Path, dry_run: bool = False) -> Dict[str, bool]:
        """批量处理多个文件夹"""
        if not parent_dir.exists() or not parent_dir.is_dir():
            self.logger.error(f"Parent directory does not exist: {parent_dir}")
            return {}
        
        results = {}
        subdirs = [d for d in parent_dir.iterdir() if d.is_dir()]
        
        if not subdirs:
            self.logger.warning(f"No subdirectories found in {parent_dir}")
            return {}
        
        self.logger.info(f"Found {len(subdirs)} directories to process")
        
        for subdir in subdirs:
            self.logger.info(f"Processing directory: {subdir.name}")
            try:
                output_file = parent_dir / f"{subdir.name}.mp4"
                success = self.merge_single_folder(subdir, output_file, dry_run)
                results[str(subdir)] = success
                
                if success:
                    self.logger.info(f"✅ Successfully processed: {subdir.name}")
                else:
                    self.logger.error(f"❌ Failed to process: {subdir.name}")
                    
            except Exception as e:
                self.logger.error(f"Error processing {subdir.name}: {e}")
                results[str(subdir)] = False
        
        # 总结
        successful = sum(1 for success in results.values() if success)
        total = len(results)
        self.logger.info(f"Batch processing complete: {successful}/{total} successful")
        
        return results
    
    def _cleanup_temp_dir(self, temp_dir: Path):
        """清理临时目录"""
        try:
            if temp_dir.exists():
                shutil.rmtree(temp_dir)
                self.logger.debug(f"Cleaned up temp dir: {temp_dir}")
        except Exception as e:
            self.logger.warning(f"Failed to cleanup temp dir {temp_dir}: {e}")
    
    def cleanup(self):
        """清理所有临时目录"""
        for temp_dir in self.temp_dirs:
            self._cleanup_temp_dir(temp_dir)
        self.temp_dirs.clear()


def main():
    """命令行入口点"""
    import argparse
    
    parser = argparse.ArgumentParser(description="DASH Video Merger")
    parser.add_argument('path', help='Path to folder containing m4s files or parent folder for batch processing')
    parser.add_argument('--batch', action='store_true', help='Batch process all subdirectories')
    parser.add_argument('--output', '-o', help='Output file path (for single folder processing)')
    parser.add_argument('--dry-run', action='store_true', help='Preview operations without executing')
    parser.add_argument('--verbose', '-v', action='store_true', help='Verbose output')
    
    args = parser.parse_args()
    
    merger = DashMerger(verbose=args.verbose)
    
    try:
        # 检查依赖
        if not merger.check_dependencies():
            return 1
        
        path = Path(args.path)
        
        if args.batch:
            # 批量处理
            results = merger.merge_batch(path, dry_run=args.dry_run)
            failed = sum(1 for success in results.values() if not success)
            return 0 if failed == 0 else 1
        else:
            # 单文件夹处理
            output_file = Path(args.output) if args.output else None
            success = merger.merge_single_folder(path, output_file, dry_run=args.dry_run)
            return 0 if success else 1
            
    except KeyboardInterrupt:
        merger.logger.info("Operation cancelled by user")
        return 130
    except Exception as e:
        merger.logger.error(f"Unexpected error: {e}")
        return 1
    finally:
        merger.cleanup()


if __name__ == "__main__":
    exit(main()) 