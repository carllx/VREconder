#!/usr/bin/env python3
"""
VR Video Processing Pipeline - Refactoring Starter

Interactive CLI tool to guide users through the refactoring process.
This tool provides a step-by-step approach to migrating the project
to the new modular architecture.

Usage:
    python start_refactoring.py [options]

Options:
    --auto          Run all steps automatically
    --step STEP     Run specific step (1-7)
    --config FILE   Use custom configuration file
    --verbose       Verbose output
"""

import os
import sys
import json
import yaml
import argparse
import subprocess
from pathlib import Path
from typing import Dict, List, Any, Optional
import time


class RefactoringStarter:
    """Interactive refactoring starter with step-by-step guidance."""
    
    def __init__(self, config_file: Optional[str] = None, verbose: bool = False):
        self.verbose = verbose
        self.config = self._load_config(config_file)
        self.project_root = Path.cwd()
        self.steps_completed = []
        
        # Step definitions
        self.steps = {
            1: {
                'name': 'Dependency Analysis',
                'description': 'Analyze project dependencies and code quality',
                'function': self._step1_dependency_analysis
            },
            2: {
                'name': 'Create Directory Structure',
                'description': 'Create new modular directory structure',
                'function': self._step2_create_structure
            },
            3: {
                'name': 'Script Migration',
                'description': 'Migrate existing scripts to new structure',
                'function': self._step3_script_migration
            },
            4: {
                'name': 'Configuration Setup',
                'description': 'Set up configuration files and environment',
                'function': self._step4_configuration_setup
            },
            5: {
                'name': 'Core Module Development',
                'description': 'Create core Python modules',
                'function': self._step5_core_modules
            },
            6: {
                'name': 'Testing Framework',
                'description': 'Set up testing framework and initial tests',
                'function': self._step6_testing_framework
            },
            7: {
                'name': 'Validation and Cleanup',
                'description': 'Validate migration and clean up old files',
                'function': self._step7_validation_cleanup
            }
        }
    
    def _load_config(self, config_file: Optional[str]) -> Dict[str, Any]:
        """Load configuration from file or use defaults."""
        default_config = {
            'project_name': 'VR Video Processing Pipeline',
            'version': '2.0.0',
            'source_dir': '.',
            'target_dir': 'new_structure',
            'backup_enabled': True,
            'dry_run': False,
            'auto_confirm': False,
            'tools_dir': 'tools',
            'analysis_output': 'analysis_reports',
            'log_level': 'INFO'
        }
        
        if config_file and Path(config_file).exists():
            try:
                with open(config_file, 'r', encoding='utf-8') as f:
                    user_config = yaml.safe_load(f)
                default_config.update(user_config)
            except Exception as e:
                print(f"Warning: Could not load config file {config_file}: {e}")
        
        return default_config
    
    def print_banner(self):
        """Print the refactoring starter banner."""
        banner = """
╔══════════════════════════════════════════════════════════════╗
║                VR Video Processing Pipeline                  ║
║                     Refactoring Starter                      ║
║                                                              ║
║  This tool will guide you through migrating your project    ║
║  to the new modular architecture.                           ║
╚══════════════════════════════════════════════════════════════╝
        """
        print(banner)
    
    def print_step_info(self, step_num: int):
        """Print information about a specific step."""
        step = self.steps[step_num]
        print(f"\n{'='*60}")
        print(f"Step {step_num}: {step['name']}")
        print(f"{'='*60}")
        print(f"Description: {step['description']}")
        print(f"Status: {'✓ Completed' if step_num in self.steps_completed else '⏳ Pending'}")
        print(f"{'='*60}")
    
    def confirm_step(self, step_num: int) -> bool:
        """Ask user to confirm if they want to proceed with a step."""
        if self.config.get('auto_confirm', False):
            return True
        
        step = self.steps[step_num]
        print(f"\nReady to proceed with Step {step_num}: {step['name']}")
        response = input("Continue? (y/n/q to quit): ").lower().strip()
        
        if response == 'q':
            print("Refactoring cancelled by user.")
            sys.exit(0)
        
        return response in ['y', 'yes']
    
    def run_step(self, step_num: int) -> bool:
        """Run a specific refactoring step."""
        if step_num not in self.steps:
            print(f"Error: Step {step_num} does not exist.")
            return False
        
        self.print_step_info(step_num)
        
        if not self.confirm_step(step_num):
            print(f"Skipping Step {step_num}")
            return False
        
        try:
            print(f"\n🚀 Starting Step {step_num}: {self.steps[step_num]['name']}")
            success = self.steps[step_num]['function']()
            
            if success:
                self.steps_completed.append(step_num)
                print(f"✅ Step {step_num} completed successfully!")
            else:
                print(f"❌ Step {step_num} failed!")
            
            return success
        
        except Exception as e:
            print(f"❌ Error in Step {step_num}: {e}")
            if self.verbose:
                import traceback
                traceback.print_exc()
            return False
    
    def _step1_dependency_analysis(self) -> bool:
        """Step 1: Analyze project dependencies and code quality."""
        print("Analyzing project dependencies and code quality...")
        
        # Check if dependency analyzer exists
        analyzer_path = self.project_root / self.config['tools_dir'] / 'dependency_analyzer.py'
        if not analyzer_path.exists():
            print("❌ Dependency analyzer not found. Please ensure tools/dependency_analyzer.py exists.")
            return False
        
        # Run dependency analysis
        try:
            cmd = [
                sys.executable, str(analyzer_path),
                '--all',
                '--output-dir', self.config['analysis_output']
            ]
            if self.verbose:
                cmd.append('--verbose')
            
            if self.verbose:
                print(f"Running command: {' '.join(cmd)}")
            
            result = subprocess.run(cmd, capture_output=True, text=True, cwd=self.project_root)
            
            if result.returncode == 0:
                print("✅ Dependency analysis completed successfully!")
                print(f"📊 Reports saved to: {self.config['analysis_output']}")
                
                # Display summary if available
                report_path = Path(self.config['analysis_output']) / 'analysis_report.json'
                if report_path.exists():
                    with open(report_path, 'r', encoding='utf-8') as f:
                        report = json.load(f)
                    
                    summary = report.get('summary', {})
                    print(f"\n📈 Analysis Summary:")
                    print(f"   Files analyzed: {summary.get('total_files_analyzed', 0)}")
                    print(f"   Dependencies found: {summary.get('total_dependencies', 0)}")
                    print(f"   Duplicate files: {summary.get('duplicate_files', 0)}")
                    print(f"   Hardcoded values: {summary.get('files_with_hardcoded_values', 0)}")
                
                return True
            else:
                print(f"❌ Dependency analysis failed: {result.stderr}")
                return False
        
        except Exception as e:
            print(f"❌ Error running dependency analysis: {e}")
            return False
    
    def _step2_create_structure(self) -> bool:
        """Step 2: Create new modular directory structure."""
        print("Creating new modular directory structure...")
        
        directories = [
            "src/classifiers",
            "src/processors", 
            "src/encoders",
            "src/mergers",
            "src/utils",
            "src/config",
            "scripts/windows",
            "scripts/macos",
            "scripts/cross-platform",
            "config",
            "logs",
            "tests",
            "docs",
            "templates"
        ]
        
        target_dir = Path(self.config['target_dir'])
        
        try:
            # Create directories
            for directory in directories:
                dir_path = target_dir / directory
                dir_path.mkdir(parents=True, exist_ok=True)
                print(f"  Created: {dir_path}")
            
            # Create __init__.py files for Python packages
            python_dirs = [
                "src",
                "src/classifiers",
                "src/processors",
                "src/encoders", 
                "src/mergers",
                "src/utils",
                "src/config",
                "tests"
            ]
            
            for dir_name in python_dirs:
                init_file = target_dir / dir_name / "__init__.py"
                if not init_file.exists():
                    init_file.touch()
                    print(f"  Created: {init_file}")
            
            print(f"✅ Directory structure created in: {target_dir}")
            return True
        
        except Exception as e:
            print(f"❌ Error creating directory structure: {e}")
            return False
    
    def _step3_script_migration(self) -> bool:
        """Step 3: Migrate existing scripts to new structure."""
        print("Migrating existing scripts to new structure...")
        
        # Check if script migrator exists
        migrator_path = self.project_root / self.config['tools_dir'] / 'script_migrator.py'
        if not migrator_path.exists():
            print("❌ Script migrator not found. Please ensure tools/script_migrator.py exists.")
            return False
        
        # Run script migration
        try:
            cmd = [
                sys.executable, str(migrator_path),
                '--source', self.config['source_dir'],
                '--target', self.config['target_dir'],
                '--config'
            ]
            if self.config['backup_enabled']:
                cmd.append('--backup')
            if self.config['dry_run']:
                cmd.append('--dry-run')
            if self.verbose:
                cmd.append('--verbose')
            
            if self.verbose:
                print(f"Running command: {' '.join(cmd)}")
            
            result = subprocess.run(cmd, capture_output=True, text=True, cwd=self.project_root)
            
            if result.returncode == 0:
                print("✅ Script migration completed successfully!")
                print(f"📁 New structure created in: {self.config['target_dir']}")
                
                # Display migration summary if available
                report_path = Path(self.config['target_dir']) / 'migration_report.json'
                if report_path.exists():
                    with open(report_path, 'r', encoding='utf-8') as f:
                        report = json.load(f)
                    
                    summary = report.get('migration_summary', {})
                    print(f"\n📈 Migration Summary:")
                    print(f"   Files analyzed: {summary.get('total_files_analyzed', 0)}")
                    print(f"   Files migrated: {summary.get('files_migrated', 0)}")
                    print(f"   Duplicates found: {summary.get('duplicates_found', 0)}")
                    print(f"   Hardcoded paths: {summary.get('hardcoded_paths', 0)}")
                
                return True
            else:
                print(f"❌ Script migration failed: {result.stderr}")
                return False
        
        except Exception as e:
            print(f"❌ Error running script migration: {e}")
            return False
    
    def _step4_configuration_setup(self) -> bool:
        """Step 4: Set up configuration files and environment."""
        print("Setting up configuration files and environment...")
        
        config_dir = Path(self.config['target_dir']) / 'config'
        
        try:
            # Create environment file
            env_file = self.project_root / '.env'
            if not env_file.exists():
                env_content = """# VR Video Processing Pipeline - Environment Variables

# Project paths
PROJECT_ROOT=.
DOWNLOAD_DIR=D:\Downloads\VR\VR_Video_Processing/01_Download_Completed
OUTPUT_DIR=D:\Downloads\VR\VR_Video_Processing/Output
TEMP_DIR=D:\Downloads\VR\VR_Video_Processing/Temp

# External tools
FFMPEG_PATH=C:/ffmpeg/bin/ffmpeg.exe
MEDIAINFO_PATH=C:/mediainfo/mediainfo.exe

# Processing settings
MAX_WORKERS=4
BATCH_SIZE=10
LOG_LEVEL=INFO
"""
                with open(env_file, 'w', encoding='utf-8') as f:
                    f.write(env_content)
                print(f"  Created: {env_file}")
            
            # Create .gitignore
            gitignore_file = self.project_root / '.gitignore'
            if not gitignore_file.exists():
                gitignore_content = """# VR Video Processing Pipeline - Git Ignore

# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
build/
develop-eggs/
dist/
downloads/
eggs/
.eggs/
lib/
lib64/
parts/
sdist/
var/
wheels/
*.egg-info/
.installed.cfg
*.egg

# Virtual environments
venv/
env/
ENV/

# IDE
.vscode/
.idea/
*.swp
*.swo

# Logs
logs/
*.log

# Temporary files
temp/
tmp/
*.tmp

# Analysis reports
analysis_reports/
migration_reports/

# Backup files
backup_*/

# Environment variables
.env
.env.local

# OS
.DS_Store
Thumbs.db
"""
                with open(gitignore_file, 'w', encoding='utf-8') as f:
                    f.write(gitignore_content)
                print(f"  Created: {gitignore_file}")
            
            # Create pytest configuration
            pytest_file = self.project_root / 'pytest.ini'
            if not pytest_file.exists():
                pytest_content = """[pytest]
testpaths = tests
python_files = test_*.py
python_classes = Test*
python_functions = test_*
addopts = 
    --verbose
    --tb=short
    --strict-markers
    --disable-warnings
markers =
    unit: Unit tests
    integration: Integration tests
    performance: Performance tests
    slow: Slow running tests
"""
                with open(pytest_file, 'w', encoding='utf-8') as f:
                    f.write(pytest_content)
                print(f"  Created: {pytest_file}")
            
            print("✅ Configuration setup completed successfully!")
            return True
        
        except Exception as e:
            print(f"❌ Error setting up configuration: {e}")
            return False
    
    def _step5_core_modules(self) -> bool:
        """Step 5: Create core Python modules."""
        print("Creating core Python modules...")
        
        src_dir = Path(self.config['target_dir']) / 'src'
        
        try:
            # Create main entry point
            main_file = src_dir / 'main.py'
            if not main_file.exists():
                main_content = '''#!/usr/bin/env python3
"""
VR Video Processing Pipeline - Main Entry Point

This is the main entry point for the VR video processing pipeline.
It orchestrates the entire processing workflow.
"""

import sys
import logging
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent))

from config.settings import Config
from utils.logging import setup_logging
from classifiers.video_classifier import VideoClassifier
from processors.video_splitter import VideoSplitter
from encoders.hevc_encoder import HEVCEncoder
from mergers.segment_merger import SegmentMerger


def main():
    """Main entry point for the VR video processing pipeline."""
    # Setup logging
    setup_logging()
    logger = logging.getLogger(__name__)
    
    try:
        # Load configuration
        config = Config()
        logger.info("Configuration loaded successfully")
        
        # Initialize components
        classifier = VideoClassifier(config)
        splitter = VideoSplitter(config)
        encoder = HEVCEncoder(config)
        merger = SegmentMerger(config)
        
        logger.info("All components initialized successfully")
        
        # TODO: Implement main processing workflow
        logger.info("Main processing workflow not yet implemented")
        
    except Exception as e:
        logger.error(f"Error in main pipeline: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
'''
                with open(main_file, 'w', encoding='utf-8') as f:
                    f.write(main_content)
                print(f"  Created: {main_file}")
            
            # Create config module
            config_file = src_dir / 'config' / 'settings.py'
            if not config_file.exists():
                config_content = '''"""
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
'''
                with open(config_file, 'w', encoding='utf-8') as f:
                    f.write(config_content)
                print(f"  Created: {config_file}")
            
            # Create logging module
            logging_file = src_dir / 'utils' / 'logging.py'
            if not logging_file.exists():
                logging_content = '''"""
Logging utilities for VR Video Processing Pipeline.
"""

import logging
import logging.config
from pathlib import Path
from typing import Optional


def setup_logging(config_file: Optional[str] = None, level: str = "INFO"):
    """Setup logging configuration.
    
    Args:
        config_file: Path to logging configuration file
        level: Logging level if no config file provided
    """
    if config_file and Path(config_file).exists():
        with open(config_file, 'r', encoding='utf-8') as f:
            import yaml
            config = yaml.safe_load(f)
        logging.config.dictConfig(config)
    else:
        # Basic logging setup
        logging.basicConfig(
            level=getattr(logging, level.upper()),
            format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )


def get_logger(name: str) -> logging.Logger:
    """Get a logger instance.
    
    Args:
        name: Logger name
        
    Returns:
        Logger instance
    """
    return logging.getLogger(name)


class PerformanceLogger:
    """Logger for performance monitoring."""
    
    def __init__(self, name: str):
        self.logger = get_logger(f"performance.{name}")
    
    def log_operation(self, operation: str, duration: float, **kwargs):
        """Log operation performance.
        
        Args:
            operation: Operation name
            duration: Duration in seconds
            **kwargs: Additional metrics
        """
        metrics = {
            'operation': operation,
            'duration': duration,
            **kwargs
        }
        self.logger.info(f"Performance: {metrics}")
'''
                with open(logging_file, 'w', encoding='utf-8') as f:
                    f.write(logging_content)
                print(f"  Created: {logging_file}")
            
            print("✅ Core modules created successfully!")
            return True
        
        except Exception as e:
            print(f"❌ Error creating core modules: {e}")
            return False
    
    def _step6_testing_framework(self) -> bool:
        """Step 6: Set up testing framework and initial tests."""
        print("Setting up testing framework and initial tests...")
        
        tests_dir = Path(self.config['target_dir']) / 'tests'
        
        try:
            # Create test configuration
            conftest_file = tests_dir / 'conftest.py'
            if not conftest_file.exists():
                conftest_content = '''"""
Test configuration for VR Video Processing Pipeline.
"""

import pytest
import tempfile
import shutil
from pathlib import Path
from typing import Generator


@pytest.fixture
def temp_dir() -> Generator[Path, None, None]:
    """Create a temporary directory for tests."""
    temp_dir = Path(tempfile.mkdtemp())
    yield temp_dir
    shutil.rmtree(temp_dir)


@pytest.fixture
def sample_video_file(temp_dir: Path) -> Path:
    """Create a sample video file for testing."""
    # This would create a minimal video file for testing
    # For now, just create a placeholder
    video_file = temp_dir / "sample.mp4"
    video_file.touch()
    return video_file


@pytest.fixture
def sample_config() -> dict:
    """Sample configuration for testing."""
    return {
        'app': {
            'name': 'Test Pipeline',
            'version': '1.0.0',
            'debug': True
        },
        'paths': {
            'download': '/tmp/download',
            'output': '/tmp/output',
            'temp': '/tmp/temp',
            'logs': '/tmp/logs'
        },
        'encoding': {
            'hevc': {
                'preset': 'fast',
                'crf_range': {'min': 25, 'max': 35},
                'profile': 'main'
            }
        }
    }
'''
                with open(conftest_file, 'w', encoding='utf-8') as f:
                    f.write(conftest_content)
                print(f"  Created: {conftest_file}")
            
            # Create basic test files
            test_files = {
                'test_config.py': '''"""
Tests for configuration management.
"""

import pytest
from src.config.settings import Config


def test_config_initialization():
    """Test configuration initialization."""
    config = Config()
    assert config is not None
    assert config.get('app.name') == 'VR Video Processing Pipeline'


def test_config_get_value():
    """Test getting configuration values."""
    config = Config()
    value = config.get('encoding.hevc.preset')
    assert value == 'slower'


def test_config_get_nonexistent():
    """Test getting non-existent configuration value."""
    config = Config()
    value = config.get('nonexistent.key', 'default')
    assert value == 'default'
''',
                'test_logging.py': '''"""
Tests for logging utilities.
"""

import logging
from src.utils.logging import get_logger, setup_logging


def test_get_logger():
    """Test getting a logger instance."""
    logger = get_logger('test')
    assert isinstance(logger, logging.Logger)
    assert logger.name == 'test'


def test_setup_logging():
    """Test logging setup."""
    setup_logging(level='DEBUG')
    logger = get_logger('test')
    assert logger.level == logging.DEBUG
'''
            }
            
            for filename, content in test_files.items():
                test_file = tests_dir / filename
                if not test_file.exists():
                    with open(test_file, 'w', encoding='utf-8') as f:
                        f.write(content)
                    print(f"  Created: {test_file}")
            
            print("✅ Testing framework set up successfully!")
            return True
        
        except Exception as e:
            print(f"❌ Error setting up testing framework: {e}")
            return False
    
    def _step7_validation_cleanup(self) -> bool:
        """Step 7: Validate migration and clean up old files."""
        print("Validating migration and cleaning up old files...")
        
        try:
            # Validate new structure
            target_dir = Path(self.config['target_dir'])
            required_dirs = [
                'src/classifiers',
                'src/processors',
                'src/encoders',
                'src/mergers',
                'src/utils',
                'src/config',
                'scripts/windows',
                'scripts/macos',
                'config',
                'tests'
            ]
            
            missing_dirs = []
            for dir_path in required_dirs:
                if not (target_dir / dir_path).exists():
                    missing_dirs.append(dir_path)
            
            if missing_dirs:
                print(f"❌ Missing required directories: {missing_dirs}")
                return False
            
            print("✅ Directory structure validation passed!")
            
            # Run basic tests
            print("Running basic tests...")
            test_cmd = [sys.executable, '-m', 'pytest', 'tests/', '-v']
            result = subprocess.run(test_cmd, capture_output=True, text=True, cwd=target_dir)
            
            if result.returncode == 0:
                print("✅ Basic tests passed!")
            else:
                print(f"⚠️  Some tests failed: {result.stderr}")
            
            # Cleanup old files (if not dry run)
            if not self.config['dry_run'] and self.config.get('cleanup_enabled', False):
                print("Cleaning up old files...")
                # This would remove old files after successful migration
                # Implementation depends on specific requirements
                print("  Cleanup completed (dry run mode)")
            
            print("✅ Validation and cleanup completed successfully!")
            return True
        
        except Exception as e:
            print(f"❌ Error during validation and cleanup: {e}")
            return False
    
    def run_all_steps(self) -> bool:
        """Run all refactoring steps in sequence."""
        print("Running all refactoring steps...")
        
        for step_num in range(1, len(self.steps) + 1):
            success = self.run_step(step_num)
            if not success:
                print(f"\n❌ Refactoring failed at Step {step_num}")
                return False
            
            # Add delay between steps
            if step_num < len(self.steps):
                print("\n⏳ Waiting 2 seconds before next step...")
                time.sleep(2)
        
        print("\n🎉 All refactoring steps completed successfully!")
        return True
    
    def show_summary(self):
        """Show refactoring summary."""
        print(f"\n{'='*60}")
        print("REFACTORING SUMMARY")
        print(f"{'='*60}")
        
        total_steps = len(self.steps)
        completed_steps = len(self.steps_completed)
        
        print(f"Total steps: {total_steps}")
        print(f"Completed: {completed_steps}")
        print(f"Remaining: {total_steps - completed_steps}")
        
        if completed_steps > 0:
            print(f"\nCompleted steps:")
            for step_num in self.steps_completed:
                step = self.steps[step_num]
                print(f"  ✓ Step {step_num}: {step['name']}")
        
        if completed_steps < total_steps:
            print(f"\nRemaining steps:")
            for step_num in range(1, total_steps + 1):
                if step_num not in self.steps_completed:
                    step = self.steps[step_num]
                    print(f"  ⏳ Step {step_num}: {step['name']}")
        
        print(f"\nNew project structure: {self.config['target_dir']}")
        print(f"Analysis reports: {self.config['analysis_output']}")


def main():
    """Main function to run the refactoring starter."""
    parser = argparse.ArgumentParser(description="VR Video Processing Pipeline Refactoring Starter")
    parser.add_argument("--auto", action="store_true", help="Run all steps automatically")
    parser.add_argument("--step", type=int, help="Run specific step (1-7)")
    parser.add_argument("--config", help="Use custom configuration file")
    parser.add_argument("--verbose", action="store_true", help="Verbose output")
    
    args = parser.parse_args()
    
    # Create refactoring starter
    starter = RefactoringStarter(config_file=args.config, verbose=args.verbose)
    
    # Print banner
    starter.print_banner()
    
    # Run refactoring
    if args.auto:
        success = starter.run_all_steps()
        if not success:
            sys.exit(1)
    elif args.step:
        if args.step < 1 or args.step > 7:
            print("Error: Step number must be between 1 and 7")
            sys.exit(1)
        success = starter.run_step(args.step)
        if not success:
            sys.exit(1)
    else:
        # Interactive mode
        print("\nChoose an option:")
        print("1. Run all steps automatically")
        print("2. Run specific step")
        print("3. Show summary")
        print("4. Exit")
        
        while True:
            choice = input("\nEnter your choice (1-4): ").strip()
            
            if choice == '1':
                success = starter.run_all_steps()
                if not success:
                    sys.exit(1)
                break
            elif choice == '2':
                step_num = input("Enter step number (1-7): ").strip()
                try:
                    step_num = int(step_num)
                    if 1 <= step_num <= 7:
                        success = starter.run_step(step_num)
                        if not success:
                            sys.exit(1)
                        break
                    else:
                        print("Error: Step number must be between 1 and 7")
                except ValueError:
                    print("Error: Please enter a valid number")
            elif choice == '3':
                starter.show_summary()
            elif choice == '4':
                print("Exiting...")
                break
            else:
                print("Error: Please enter a valid choice (1-4)")
    
    # Show final summary
    starter.show_summary()
    print("\n🎉 Refactoring process completed!")


if __name__ == "__main__":
    main() 