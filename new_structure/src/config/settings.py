"""
Configuration management for VR Video Processing Pipeline.
"""

import os
import yaml
from pathlib import Path
from typing import Dict, Any, Optional


class Config:
    """Configuration manager for the VR video processing pipeline."""
    
    def __init__(self, config_file: Optional[str] = None):
        """Initialize configuration.
        
        Args:
            config_file: Path to configuration file. If None, uses default.
        """
        self.config_file = config_file or "config/settings.yaml"
        self.settings = self._load_config()
    
    def _load_config(self) -> Dict[str, Any]:
        """Load configuration from file."""
        config_path = Path(self.config_file)
        
        if not config_path.exists():
            return self._get_default_config()
        
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                config = yaml.safe_load(f)
            return config
        except Exception as e:
            print(f"Warning: Could not load config file {config_file}: {e}")
            return self._get_default_config()
    
    def _get_default_config(self) -> Dict[str, Any]:
        """Get default configuration."""
        return {
            'app': {
                'name': 'VR Video Processing Pipeline',
                'version': '2.0.0',
                'debug': False
            },
            'paths': {
                'download': os.getenv('DOWNLOAD_DIR', '.'),
                'output': os.getenv('OUTPUT_DIR', 'output'),
                'temp': os.getenv('TEMP_DIR', 'temp'),
                'logs': os.getenv('LOG_DIR', 'logs')
            },
            'encoding': {
                'hevc': {
                    'preset': 'slower',
                    'crf_range': {'min': 20, 'max': 38},
                    'profile': 'main10'
                }
            },
            'processing': {
                'max_workers': int(os.getenv('MAX_WORKERS', '4')),
                'batch_size': int(os.getenv('BATCH_SIZE', '10')),
                'timeout': int(os.getenv('TIMEOUT', '3600'))
            }
        }
    
    def get(self, key: str, default: Any = None) -> Any:
        """Get configuration value by key."""
        keys = key.split('.')
        value = self.settings
        
        for k in keys:
            if isinstance(value, dict) and k in value:
                value = value[k]
            else:
                return default
        
        return value
    
    def get_path(self, key: str, default: str = None) -> str:
        from utils.resolve_path import resolve_path  # 延迟导入，避免循环依赖
        raw = self.get(key, default)
        return resolve_path(raw, self)
    
    def set(self, key: str, value: Any):
        """Set configuration value by key."""
        keys = key.split('.')
        config = self.settings
        
        for k in keys[:-1]:
            if k not in config:
                config[k] = {}
            config = config[k]
        
        config[keys[-1]] = value
    
    def save(self):
        """Save configuration to file."""
        config_path = Path(self.config_file)
        config_path.parent.mkdir(parents=True, exist_ok=True)
        
        with open(config_path, 'w', encoding='utf-8') as f:
            yaml.dump(self.settings, f, default_flow_style=False, indent=2)
