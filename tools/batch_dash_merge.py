#!/usr/bin/env python3
"""
批量DASH合并脚本
高效并行处理多个文件夹中的DASH视频分段，提供用户友好的界面和详细的处理报告

特点:
- 并行处理多个文件夹
- 实时进度显示
- 详细的处理报告
- 错误恢复和重试
- 用户友好的输入输出机制
"""

import os
import sys
import time
import json
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, asdict
from typing import List, Dict, Optional, Tuple
import logging
from datetime import datetime

# 添加项目根目录到路径
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from src.combiners.dash_merger import DashMerger


@dataclass
class ProcessingResult:
    """处理结果数据类"""
    folder_name: str
    input_path: str
    output_path: str
    success: bool
    start_time: float
    end_time: float
    duration: float
    error_message: str = ""
    files_processed: int = 0
    total_size_mb: float = 0.0


class BatchDashMerger:
    """批量DASH合并器"""
    
    def __init__(self, max_workers: int = 4, verbose: bool = False):
        self.max_workers = max_workers
        self.verbose = verbose
        self.logger = self._setup_logging()
        self.results: List[ProcessingResult] = []
        self.start_time = time.time()
        self.progress_lock = threading.Lock()
        self.completed_count = 0
        self.total_count = 0
        
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
    
    def scan_dash_folders(self, parent_dir: Path) -> List[Path]:
        """扫描包含DASH文件的文件夹"""
        dash_folders = []
        
        if not parent_dir.exists() or not parent_dir.is_dir():
            self.logger.error(f"Parent directory does not exist: {parent_dir}")
            return dash_folders
        
        for folder in parent_dir.iterdir():
            if folder.is_dir():
                # 检查是否包含.m4s文件
                m4s_files = list(folder.glob("*.m4s"))
                if m4s_files:
                    dash_folders.append(folder)
                    self.logger.debug(f"Found DASH folder: {folder.name} ({len(m4s_files)} m4s files)")
        
        return dash_folders
    
    def get_folder_info(self, folder_path: Path) -> Dict[str, any]:
        """获取文件夹信息"""
        m4s_files = list(folder_path.glob("*.m4s"))
        init_files = list(folder_path.glob("init.mp4"))
        
        total_size = sum(f.stat().st_size for f in m4s_files + init_files)
        total_size_mb = total_size / (1024 * 1024)
        
        # 分析P标识符
        identifiers = set()
        for file in m4s_files:
            merger = DashMerger()
            file_info = merger.parse_m4s_filename(file.name)
            if file_info:
                identifiers.add(file_info['identifier'])
        
        return {
            'total_files': len(m4s_files),
            'init_files': len(init_files),
            'total_size_mb': total_size_mb,
            'identifiers': sorted(identifiers),
            'identifier_count': len(identifiers)
        }
    
    def display_scan_summary(self, dash_folders: List[Path], parent_dir: Path):
        """显示扫描摘要"""
        print(f"\n🔍 扫描目录: {parent_dir}")
        print("=" * 80)
        
        if not dash_folders:
            print("❌ 未找到包含DASH文件的文件夹")
            return
        
        print(f"📁 找到 {len(dash_folders)} 个DASH文件夹:")
        print("-" * 80)
        
        total_files = 0
        total_size = 0.0
        
        for i, folder in enumerate(dash_folders, 1):
            info = self.get_folder_info(folder)
            total_files += info['total_files']
            total_size += info['total_size_mb']
            
            print(f"{i:3d}. {folder.name}")
            print(f"     📄 文件: {info['total_files']} m4s + {info['init_files']} init")
            print(f"     📊 大小: {info['total_size_mb']:.1f} MB")
            print(f"     🎬 段落: {info['identifier_count']} 个 (P{', P'.join(info['identifiers'])})")
            print()
        
        print("-" * 80)
        print(f"📊 总计: {len(dash_folders)} 文件夹, {total_files} 文件, {total_size:.1f} MB")
        print("=" * 80)
    
    def process_single_folder(self, folder_path: Path, output_dir: Path) -> ProcessingResult:
        """处理单个文件夹"""
        start_time = time.time()
        folder_name = folder_path.name
        
        # 创建输出文件路径
        output_file = output_dir / f"{folder_name}.mp4"
        
        # 获取文件夹信息
        folder_info = self.get_folder_info(folder_path)
        
        try:
            # 创建DASH合并器
            merger = DashMerger(verbose=False)  # 减少日志输出避免混乱
            
            # 执行合并
            success = merger.merge_single_folder(folder_path, output_file, dry_run=False)
            
            end_time = time.time()
            duration = end_time - start_time
            
            # 更新进度
            with self.progress_lock:
                self.completed_count += 1
                progress = (self.completed_count / self.total_count) * 100
                print(f"✅ [{self.completed_count}/{self.total_count}] {progress:.1f}% | {folder_name} | {duration:.1f}s")
            
            return ProcessingResult(
                folder_name=folder_name,
                input_path=str(folder_path),
                output_path=str(output_file) if success else "",
                success=success,
                start_time=start_time,
                end_time=end_time,
                duration=duration,
                files_processed=folder_info['total_files'],
                total_size_mb=folder_info['total_size_mb']
            )
            
        except Exception as e:
            end_time = time.time()
            duration = end_time - start_time
            
            with self.progress_lock:
                self.completed_count += 1
                progress = (self.completed_count / self.total_count) * 100
                print(f"❌ [{self.completed_count}/{self.total_count}] {progress:.1f}% | {folder_name} | 错误: {str(e)}")
            
            return ProcessingResult(
                folder_name=folder_name,
                input_path=str(folder_path),
                output_path="",
                success=False,
                start_time=start_time,
                end_time=end_time,
                duration=duration,
                error_message=str(e),
                files_processed=folder_info['total_files'],
                total_size_mb=folder_info['total_size_mb']
            )
    
    def process_batch(self, parent_dir: Path, output_dir: Path, dry_run: bool = False) -> List[ProcessingResult]:
        """批量处理DASH文件夹"""
        # 扫描文件夹
        dash_folders = self.scan_dash_folders(parent_dir)
        
        if not dash_folders:
            return []
        
        # 显示扫描摘要
        self.display_scan_summary(dash_folders, parent_dir)
        
        if dry_run:
            print("\n🔍 模拟运行模式 - 不会实际处理文件")
            return []
        
        # 确认处理
        try:
            response = input(f"\n🤔 确定要处理这 {len(dash_folders)} 个文件夹吗? (y/N): ").strip().lower()
            if response not in ['y', 'yes']:
                print("❌ 用户取消操作")
                return []
        except KeyboardInterrupt:
            print("\n❌ 用户中断操作")
            return []
        
        # 确保输出目录存在
        output_dir.mkdir(parents=True, exist_ok=True)
        
        # 初始化进度跟踪
        self.total_count = len(dash_folders)
        self.completed_count = 0
        
        print(f"\n🚀 开始批量处理 ({self.max_workers} 个并行任务)")
        print("=" * 80)
        
        # 并行处理
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            # 提交任务
            future_to_folder = {
                executor.submit(self.process_single_folder, folder, output_dir): folder 
                for folder in dash_folders
            }
            
            # 收集结果
            for future in as_completed(future_to_folder):
                result = future.result()
                self.results.append(result)
        
        return self.results
    
    def generate_report(self, output_dir: Path) -> Path:
        """生成处理报告"""
        if not self.results:
            return None
        
        # 计算统计信息
        total_time = time.time() - self.start_time
        successful = [r for r in self.results if r.success]
        failed = [r for r in self.results if not r.success]
        
        total_files = sum(r.files_processed for r in self.results)
        total_size = sum(r.total_size_mb for r in self.results)
        processing_time = sum(r.duration for r in self.results)
        
        # 创建报告
        report = {
            'summary': {
                'total_folders': len(self.results),
                'successful': len(successful),
                'failed': len(failed),
                'success_rate': len(successful) / len(self.results) * 100,
                'total_time_seconds': total_time,
                'total_processing_time_seconds': processing_time,
                'total_files_processed': total_files,
                'total_size_mb': total_size,
                'average_speed_mb_per_second': total_size / processing_time if processing_time > 0 else 0,
                'parallel_efficiency': processing_time / total_time if total_time > 0 else 0,
                'timestamp': datetime.now().isoformat()
            },
            'successful_folders': [asdict(r) for r in successful],
            'failed_folders': [asdict(r) for r in failed]
        }
        
        # 保存报告
        report_file = output_dir / f"batch_dash_merge_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(report_file, 'w', encoding='utf-8') as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        
        return report_file
    
    def display_final_summary(self, report_file: Optional[Path] = None):
        """显示最终摘要"""
        if not self.results:
            return
        
        successful = [r for r in self.results if r.success]
        failed = [r for r in self.results if not r.success]
        
        total_time = time.time() - self.start_time
        total_files = sum(r.files_processed for r in self.results)
        total_size = sum(r.total_size_mb for r in self.results)
        
        print("\n" + "=" * 80)
        print("📊 批量处理完成摘要")
        print("=" * 80)
        
        print(f"✅ 成功: {len(successful)} 个文件夹")
        print(f"❌ 失败: {len(failed)} 个文件夹")
        print(f"📈 成功率: {len(successful)/len(self.results)*100:.1f}%")
        print(f"⏱️  总耗时: {total_time:.1f} 秒")
        print(f"📄 处理文件: {total_files} 个")
        print(f"📊 处理大小: {total_size:.1f} MB")
        print(f"🚀 平均速度: {total_size/total_time:.1f} MB/s")
        
        if failed:
            print(f"\n❌ 失败的文件夹:")
            for result in failed:
                print(f"   • {result.folder_name}: {result.error_message}")
        
        if report_file:
            print(f"\n📋 详细报告: {report_file}")
        
        print("=" * 80)


def main():
    """主函数"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description="批量DASH合并工具 - 高效并行处理多个DASH文件夹",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 基本使用
  python tools/batch_dash_merge.py C:\\Users\\carll\\Desktop\\catDownloads
  
  # 指定输出目录和并行数
  python tools/batch_dash_merge.py C:\\Users\\carll\\Desktop\\catDownloads -o D:\\Output -w 6
  
  # 模拟运行（仅扫描，不处理）
  python tools/batch_dash_merge.py C:\\Users\\carll\\Desktop\\catDownloads --dry-run
  
  # 详细输出模式
  python tools/batch_dash_merge.py C:\\Users\\carll\\Desktop\\catDownloads --verbose
        """
    )
    
    parser.add_argument('input_dir', type=Path, help='包含DASH文件夹的父目录')
    parser.add_argument('-o', '--output-dir', type=Path, help='输出目录 (默认为输入目录下的merged文件夹)')
    parser.add_argument('-w', '--workers', type=int, default=4, help='并行处理任务数 (默认: 4)')
    parser.add_argument('--dry-run', action='store_true', help='模拟运行，仅扫描不处理')
    parser.add_argument('--verbose', '-v', action='store_true', help='详细输出模式')
    
    args = parser.parse_args()
    
    # 验证输入目录
    if not args.input_dir.exists():
        print(f"❌ 输入目录不存在: {args.input_dir}")
        return 1
    
    # 设置输出目录
    output_dir = args.output_dir or (args.input_dir / "merged")
    
    print(f"🎬 VREconder 批量DASH合并工具")
    print(f"📁 输入目录: {args.input_dir}")
    print(f"📁 输出目录: {output_dir}")
    print(f"🔧 并行任务: {args.workers}")
    
    try:
        # 创建批量处理器
        batch_merger = BatchDashMerger(max_workers=args.workers, verbose=args.verbose)
        
        # 执行批量处理
        results = batch_merger.process_batch(args.input_dir, output_dir, dry_run=args.dry_run)
        
        if results and not args.dry_run:
            # 生成报告
            report_file = batch_merger.generate_report(output_dir)
            
            # 显示摘要
            batch_merger.display_final_summary(report_file)
        
        # 返回适当的退出代码
        if not results:
            return 0 if args.dry_run else 1
        
        failed_count = sum(1 for r in results if not r.success)
        return 0 if failed_count == 0 else 1
        
    except KeyboardInterrupt:
        print("\n❌ 用户中断操作")
        return 130
    except Exception as e:
        print(f"❌ 程序异常: {e}")
        if args.verbose:
            import traceback
            traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main()) 