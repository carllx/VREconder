#!/usr/bin/env python3
"""
批量处理器核心模块
调用 src/main.py 的核心功能实现批量视频处理

遵循架构设计：tools/ → src/main.py → src/modules
"""
import os
import sys
import subprocess
import logging
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Optional, Tuple
import time

# 添加src到路径，以便导入核心模块
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from config.settings import Config


class BatchProcessor:
    """批量视频处理器 - 用户友好的批量处理接口"""
    
    def __init__(self, config_file: Optional[str] = None):
        """初始化批量处理器
        
        Args:
            config_file: 配置文件路径，为None时使用默认配置
        """
        self.config = Config(config_file)
        self.logger = logging.getLogger(__name__)
        
        # 获取项目根目录和src/main.py路径
        self.project_root = Path(__file__).parent.parent.parent
        self.main_script = self.project_root / "src" / "main.py"
        
        if not self.main_script.exists():
            raise FileNotFoundError(f"核心脚本未找到: {self.main_script}")
    
    def find_video_files(self, input_dir: Path, 
                        extensions: List[str] = None) -> List[Path]:
        """查找目录中的视频文件
        
        Args:
            input_dir: 输入目录
            extensions: 支持的视频格式扩展名
            
        Returns:
            视频文件路径列表
        """
        if extensions is None:
            extensions = ['.mp4', '.avi', '.mkv', '.mov', '.m4v', '.webm']
        
        video_files = []
        if not input_dir.exists():
            self.logger.error(f"输入目录不存在: {input_dir}")
            return video_files
        
        for ext in extensions:
            video_files.extend(input_dir.glob(f"*{ext}"))
            video_files.extend(input_dir.glob(f"*{ext.upper()}"))
        
        # 按文件名排序
        video_files.sort(key=lambda x: x.name.lower())
        
        self.logger.info(f"在 {input_dir} 中找到 {len(video_files)} 个视频文件")
        return video_files
    
    def process_single_file(self, input_file: Path, output_dir: Path,
                           segment_duration: float = 300.0,
                           encoder: str = "libx265",
                           quality: str = "high",
                           max_workers: int = 2,
                           skip_split_encode: bool = False,
                           force_4k: bool = False,
                           temp_dir: Optional[Path] = None) -> Tuple[bool, str]:
        """处理单个视频文件
        
        Args:
            input_file: 输入视频文件
            output_dir: 输出目录
            segment_duration: 分割时长(秒)
            encoder: 编码器类型
            quality: 质量预设
            max_workers: 最大并发数
            skip_split_encode: 跳过分割阶段的编码
            force_4k: 强制4K以内
            temp_dir: 临时目录
            
        Returns:
            (是否成功, 状态消息)
        """
        # 生成输出文件名
        output_file = output_dir / f"{input_file.stem}_final_{encoder}.mp4"
        
        # 构建调用src/main.py的命令
        cmd = [
            sys.executable, str(self.main_script), "split-encode-merge",
            "--input-file", str(input_file),
            "--output-file", str(output_file),
            "--segment-duration", str(segment_duration),
            "--encoder", encoder,
            "--quality", quality,
            "--max-workers", str(max_workers)
        ]
        
        # 添加可选参数
        if skip_split_encode:
            cmd.append("--skip-split-encode")
        
        if force_4k:
            cmd.append("--force-4k")
            
        if temp_dir:
            cmd.extend(["--temp-dir", str(temp_dir)])
        
        self.logger.info(f"开始处理: {input_file.name}")
        self.logger.info(f"输出文件: {output_file.name}")
        self.logger.debug(f"执行命令: {' '.join(cmd)}")
        
        try:
            # 执行核心处理命令
            result = subprocess.run(
                cmd, 
                capture_output=True, 
                text=True, 
                check=True,
                cwd=self.project_root  # 确保在项目根目录执行
            )
            
            # 检查输出文件是否成功生成
            if output_file.exists() and output_file.stat().st_size > 0:
                size_mb = output_file.stat().st_size / (1024 * 1024)
                success_msg = f"处理完成: {input_file.name} -> {output_file.name} ({size_mb:.2f} MB)"
                self.logger.info(success_msg)
                return True, success_msg
            else:
                error_msg = f"处理失败: {input_file.name} - 输出文件未生成或为空"
                self.logger.error(error_msg)
                return False, error_msg
                
        except subprocess.CalledProcessError as e:
            error_msg = f"处理失败: {input_file.name} - 命令执行错误: {e.stderr}"
            self.logger.error(error_msg)
            return False, error_msg
        except Exception as e:
            error_msg = f"处理失败: {input_file.name} - 未知错误: {str(e)}"
            self.logger.error(error_msg)
            return False, error_msg
    
    def process_directory(self, input_dir: Path, output_dir: Path,
                         parallel_files: int = 1,
                         **process_options) -> Dict[str, any]:
        """批量处理目录中的所有视频文件
        
        Args:
            input_dir: 输入目录
            output_dir: 输出目录
            parallel_files: 并行处理的文件数量
            **process_options: 传递给process_single_file的其他参数
            
        Returns:
            处理结果字典
        """
        self.logger.info(f"开始批量处理: {input_dir} -> {output_dir}")
        
        # 确保输出目录存在
        output_dir.mkdir(parents=True, exist_ok=True)
        
        # 查找视频文件
        video_files = self.find_video_files(input_dir)
        if not video_files:
            return {
                'success': False,
                'message': f'在 {input_dir} 中未找到支持的视频文件',
                'processed': 0,
                'failed': 0,
                'results': []
            }
        
        # 处理结果统计
        results = {
            'success': True,
            'message': '',
            'processed': 0,
            'failed': 0,
            'results': [],
            'start_time': time.time()
        }
        
        self.logger.info(f"找到 {len(video_files)} 个视频文件，并行度: {parallel_files}")
        
        # 并行处理文件
        with ThreadPoolExecutor(max_workers=parallel_files) as executor:
            future_to_file = {}
            
            for video_file in video_files:
                future = executor.submit(
                    self.process_single_file,
                    video_file, 
                    output_dir,
                    **process_options
                )
                future_to_file[future] = video_file
            
            # 收集处理结果
            for future in as_completed(future_to_file):
                video_file = future_to_file[future]
                try:
                    success, message = future.result()
                    result_entry = {
                        'file': video_file.name,
                        'success': success,
                        'message': message,
                        'timestamp': time.time()
                    }
                    results['results'].append(result_entry)
                    
                    if success:
                        results['processed'] += 1
                        print(f"[SUCCESS] {message}")
                    else:
                        results['failed'] += 1
                        print(f"[ERROR] {message}")
                        
                except Exception as e:
                    error_msg = f"处理异常: {video_file.name} - {str(e)}"
                    self.logger.error(error_msg)
                    results['results'].append({
                        'file': video_file.name,
                        'success': False,
                        'message': error_msg,
                        'timestamp': time.time()
                    })
                    results['failed'] += 1
                    print(f"[ERROR] {error_msg}")
        
        # 计算总用时
        total_time = time.time() - results['start_time']
        results['total_time'] = total_time
        
        # 生成总结消息
        if results['failed'] == 0:
            results['message'] = f"批量处理完成：成功 {results['processed']} 个文件，用时 {total_time:.1f} 秒"
            self.logger.info(results['message'])
        else:
            results['success'] = False
            results['message'] = f"批量处理完成：成功 {results['processed']} 个，失败 {results['failed']} 个，用时 {total_time:.1f} 秒"
            self.logger.warning(results['message'])
        
        return results
    
    def get_supported_encoders(self) -> List[str]:
        """获取支持的编码器列表"""
        return ['libx265', 'hevc_nvenc', 'hevc_qsv']
    
    def get_supported_qualities(self) -> List[str]:
        """获取支持的质量预设列表"""
        return ['low', 'medium', 'high', 'ultra']
    
    def validate_parameters(self, **params) -> Tuple[bool, str]:
        """验证处理参数的有效性
        
        Returns:
            (是否有效, 错误消息)
        """
        encoder = params.get('encoder', 'libx265')
        quality = params.get('quality', 'high')
        max_workers = params.get('max_workers', 2)
        segment_duration = params.get('segment_duration', 300.0)
        
        # 验证编码器
        if encoder not in self.get_supported_encoders():
            return False, f"不支持的编码器: {encoder}"
        
        # 验证质量
        if quality not in self.get_supported_qualities():
            return False, f"不支持的质量预设: {quality}"
        
        # 验证工作线程数
        if not isinstance(max_workers, int) or max_workers < 1 or max_workers > 8:
            return False, f"max_workers 必须是1-8之间的整数: {max_workers}"
        
        # 验证分割时长
        if not isinstance(segment_duration, (int, float)) or segment_duration <= 0:
            return False, f"segment_duration 必须是正数: {segment_duration}"
        
        return True, "参数验证通过" 