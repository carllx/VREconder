#!/usr/bin/env python3
"""
配置验证工具
验证VREconder项目的配置文件正确性
"""
import sys
import yaml
import argparse
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple

# 添加src到路径
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from config.settings import Config


class ConfigValidator:
    """配置验证工具"""
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.project_root = Path(__file__).parent.parent.parent
    
    def validate_config_file(self, config_path: Path) -> Tuple[bool, List[str], List[str]]:
        """验证配置文件
        
        Returns:
            (是否有效, 错误列表, 警告列表)
        """
        print(f"🔍 验证配置文件: {config_path}")
        print("-" * 50)
        
        errors = []
        warnings = []
        
        # 检查文件存在性
        if not config_path.exists():
            errors.append(f"配置文件不存在: {config_path}")
            return False, errors, warnings
        
        # 检查文件格式
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                config_data = yaml.safe_load(f)
                print("✅ YAML格式: 有效")
        except yaml.YAMLError as e:
            errors.append(f"YAML格式错误: {e}")
            return False, errors, warnings
        except Exception as e:
            errors.append(f"文件读取错误: {e}")
            return False, errors, warnings
        
        if config_data is None:
            config_data = {}
        
        # 验证必需的配置节
        required_sections = ['app', 'paths', 'encoding', 'processing']
        
        print("\n📋 配置节检查:")
        for section in required_sections:
            if section in config_data:
                print(f"   ✅ {section}")
            else:
                warnings.append(f"缺少配置节: {section}")
                print(f"   ⚠️  {section} (缺失)")
        
        # 验证应用配置
        if 'app' in config_data:
            app_config = config_data['app']
            if not isinstance(app_config.get('name'), str):
                warnings.append("app.name 应该是字符串")
            if not isinstance(app_config.get('version'), str):
                warnings.append("app.version 应该是字符串")
        
        # 验证路径配置
        if 'paths' in config_data:
            self._validate_paths(config_data['paths'], errors, warnings)
        
        # 验证编码配置
        if 'encoding' in config_data:
            self._validate_encoding(config_data['encoding'], errors, warnings)
        
        # 验证处理配置
        if 'processing' in config_data:
            self._validate_processing(config_data['processing'], errors, warnings)
        
        return len(errors) == 0, errors, warnings
    
    def _validate_paths(self, paths_config: Dict[str, Any], errors: List[str], warnings: List[str]):
        """验证路径配置"""
        print("\n📁 路径配置检查:")
        
        # 检查基本路径
        basic_paths = ['download', 'output', 'temp', 'logs']
        for path_name in basic_paths:
            if path_name in paths_config:
                path_value = paths_config[path_name]
                try:
                    path_obj = Path(path_value)
                    # 检查父目录是否存在
                    if path_obj.parent.exists():
                        print(f"   ✅ {path_name}: {path_value}")
                    else:
                        warnings.append(f"路径 {path_name} 的父目录不存在: {path_value}")
                        print(f"   ⚠️  {path_name}: {path_value} (父目录不存在)")
                except Exception as e:
                    errors.append(f"路径 {path_name} 格式错误: {e}")
                    print(f"   ❌ {path_name}: {path_value} (格式错误)")
            else:
                warnings.append(f"缺少路径配置: {path_name}")
                print(f"   ⚠️  {path_name} (缺失)")
        
        # 检查平台特定路径
        platforms = ['windows', 'macos', 'linux']
        for platform in platforms:
            if platform in paths_config:
                platform_config = paths_config[platform]
                if 'ffmpeg_path' in platform_config:
                    ffmpeg_path = platform_config['ffmpeg_path']
                    print(f"   ✅ {platform}.ffmpeg_path: {ffmpeg_path}")
                else:
                    warnings.append(f"平台 {platform} 缺少 ffmpeg_path 配置")
    
    def _validate_encoding(self, encoding_config: Dict[str, Any], errors: List[str], warnings: List[str]):
        """验证编码配置"""
        print("\n🎬 编码配置检查:")
        
        if 'hevc' in encoding_config:
            hevc_config = encoding_config['hevc']
            
            # 检查预设
            if 'preset' in hevc_config:
                preset = hevc_config['preset']
                valid_presets = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 
                               'medium', 'slow', 'slower', 'veryslow']
                if preset in valid_presets:
                    print(f"   ✅ hevc.preset: {preset}")
                else:
                    errors.append(f"无效的HEVC预设: {preset}")
                    print(f"   ❌ hevc.preset: {preset} (无效)")
            
            # 检查CRF范围
            if 'crf_range' in hevc_config:
                crf_range = hevc_config['crf_range']
                if isinstance(crf_range, dict):
                    crf_min = crf_range.get('min', 0)
                    crf_max = crf_range.get('max', 51)
                    if 0 <= crf_min <= 51 and 0 <= crf_max <= 51 and crf_min <= crf_max:
                        print(f"   ✅ hevc.crf_range: {crf_min}-{crf_max}")
                    else:
                        errors.append(f"无效的CRF范围: min={crf_min}, max={crf_max}")
                        print(f"   ❌ hevc.crf_range: {crf_min}-{crf_max} (无效)")
                else:
                    errors.append("hevc.crf_range 应该是字典格式")
            
            # 检查配置文件
            if 'profile' in hevc_config:
                profile = hevc_config['profile']
                valid_profiles = ['main', 'main10', 'main12']
                if profile in valid_profiles:
                    print(f"   ✅ hevc.profile: {profile}")
                else:
                    warnings.append(f"HEVC配置文件可能不受支持: {profile}")
                    print(f"   ⚠️  hevc.profile: {profile} (可能不支持)")
    
    def _validate_processing(self, processing_config: Dict[str, Any], errors: List[str], warnings: List[str]):
        """验证处理配置"""
        print("\n⚙️  处理配置检查:")
        
        # 检查工作线程数
        if 'max_workers' in processing_config:
            max_workers = processing_config['max_workers']
            if isinstance(max_workers, int) and 1 <= max_workers <= 32:
                print(f"   ✅ max_workers: {max_workers}")
            else:
                warnings.append(f"max_workers 建议在1-32之间: {max_workers}")
                print(f"   ⚠️  max_workers: {max_workers} (建议1-32)")
        
        # 检查批处理大小
        if 'batch_size' in processing_config:
            batch_size = processing_config['batch_size']
            if isinstance(batch_size, int) and 1 <= batch_size <= 100:
                print(f"   ✅ batch_size: {batch_size}")
            else:
                warnings.append(f"batch_size 建议在1-100之间: {batch_size}")
                print(f"   ⚠️  batch_size: {batch_size} (建议1-100)")
        
        # 检查超时设置
        if 'timeout' in processing_config:
            timeout = processing_config['timeout']
            if isinstance(timeout, int) and timeout > 0:
                print(f"   ✅ timeout: {timeout}秒")
            else:
                errors.append(f"timeout 必须是正整数: {timeout}")
                print(f"   ❌ timeout: {timeout} (必须是正整数)")
    
    def test_config_loading(self, config_path: Path) -> bool:
        """测试配置加载"""
        print(f"\n🧪 测试配置加载...")
        print("-" * 30)
        
        try:
            # 测试通过Config类加载
            config = Config(str(config_path))
            print("✅ 配置加载: 成功")
            
            # 测试一些基本的获取操作
            app_name = config.get('app.name', 'Unknown')
            print(f"   应用名称: {app_name}")
            
            max_workers = config.get('processing.max_workers', 4)
            print(f"   最大工作线程: {max_workers}")
            
            # 测试路径解析
            try:
                temp_path = config.get_path('paths.temp', './temp')
                print(f"   临时路径: {temp_path}")
            except Exception as e:
                print(f"   ⚠️  路径解析失败: {e}")
            
            return True
            
        except Exception as e:
            print(f"❌ 配置加载失败: {e}")
            return False
    
    def create_sample_config(self, output_path: Path) -> bool:
        """创建示例配置文件"""
        print(f"📝 创建示例配置文件: {output_path}")
        
        sample_config = {
            'app': {
                'name': 'VR Video Processing Pipeline',
                'version': '2.0.0',
                'debug': False
            },
            'paths': {
                'download': './downloads',
                'output': './output',
                'temp': './temp',
                'logs': './logs',
                'windows': {
                    'ffmpeg_path': 'C:/ffmpeg/bin/ffmpeg.exe'
                },
                'macos': {
                    'ffmpeg_path': '/usr/local/bin/ffmpeg'
                },
                'linux': {
                    'ffmpeg_path': '/usr/bin/ffmpeg'
                }
            },
            'encoding': {
                'hevc': {
                    'preset': 'slower',
                    'crf_range': {'min': 20, 'max': 38},
                    'profile': 'main10'
                }
            },
            'processing': {
                'max_workers': 4,
                'batch_size': 10,
                'timeout': 3600
            },
            'network': {
                'share_name': 'VR_Project',
                'access_script_auto_create': True
            }
        }
        
        try:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, 'w', encoding='utf-8') as f:
                yaml.dump(sample_config, f, default_flow_style=False, indent=2, allow_unicode=True)
            print("✅ 示例配置文件创建成功")
            return True
        except Exception as e:
            print(f"❌ 创建示例配置文件失败: {e}")
            return False
    
    def create_parser(self) -> argparse.ArgumentParser:
        """创建命令行参数解析器"""
        parser = argparse.ArgumentParser(
            description="VREconder 配置验证工具",
            formatter_class=argparse.RawDescriptionHelpFormatter,
            epilog="""
示例:
  # 验证默认配置文件
  python %(prog)s
  
  # 验证指定配置文件
  python %(prog)s --config-file custom_config.yaml
  
  # 创建示例配置文件
  python %(prog)s --create-sample --output sample_config.yaml
            """
        )
        
        parser.add_argument(
            '--config-file', 
            type=Path,
            default='config/settings.yaml',
            help='配置文件路径 (默认: config/settings.yaml)'
        )
        parser.add_argument(
            '--create-sample', 
            action='store_true',
            help='创建示例配置文件'
        )
        parser.add_argument(
            '--output', 
            type=Path,
            default='config/settings_sample.yaml',
            help='示例配置文件输出路径'
        )
        parser.add_argument(
            '--verbose', '-v', 
            action='store_true',
            help='详细输出'
        )
        
        return parser
    
    def main(self, argv=None):
        """主函数"""
        parser = self.create_parser()
        args = parser.parse_args(argv)
        
        # 设置日志
        level = logging.DEBUG if args.verbose else logging.INFO
        logging.basicConfig(level=level, format='%(levelname)s: %(message)s')
        
        try:
            print("⚙️  VREconder 配置验证工具")
            print("=" * 50)
            
            if args.create_sample:
                success = self.create_sample_config(args.output)
                return 0 if success else 1
            
            # 验证配置文件
            config_path = self.project_root / args.config_file
            is_valid, errors, warnings = self.validate_config_file(config_path)
            
            # 测试配置加载
            if is_valid:
                load_success = self.test_config_loading(config_path)
                if not load_success:
                    is_valid = False
            
            # 显示结果
            print("\n" + "=" * 50)
            
            if errors:
                print("❌ 发现错误:")
                for error in errors:
                    print(f"   - {error}")
            
            if warnings:
                print("⚠️  发现警告:")
                for warning in warnings:
                    print(f"   - {warning}")
            
            if is_valid and not warnings:
                print("✅ 配置验证通过，未发现问题")
                return 0
            elif is_valid:
                print("✅ 配置基本有效，但有一些建议改进的地方")
                return 0
            else:
                print("❌ 配置验证失败，请修复错误后重试")
                return 1
                
        except KeyboardInterrupt:
            print("\n⚠️  用户中断操作")
            return 130
        except Exception as e:
            print(f"\n❌ 验证过程出错: {e}")
            if args.verbose:
                import traceback
                traceback.print_exc()
            return 1


def main():
    """入口点函数"""
    validator = ConfigValidator()
    sys.exit(validator.main())


if __name__ == "__main__":
    main() 