#!/usr/bin/env python3
"""
Cleanup redundant files after refactoring.

This script removes redundant files that were not properly cleaned up
after the migration process.
"""

import os
import shutil
from pathlib import Path
from typing import List, Set
import json


class RedundantFileCleaner:
    """Clean up redundant files after refactoring."""
    
    def __init__(self, project_root: Path):
        self.project_root = project_root
        self.new_structure = project_root / "new_structure"
        self.backup_dir = project_root / "backup_before_migration_20250720_151603"
        
    def get_migrated_files(self) -> Set[str]:
        """Get list of files that were successfully migrated."""
        migrated_files = set()
        
        # Read migration report
        report_path = self.new_structure / "migration_report.json"
        if report_path.exists():
            with open(report_path, 'r', encoding='utf-8') as f:
                report = json.load(f)
            
            for result in report.get('migration_results', []):
                if result.get('status') in ['migrated', 'auto_migrated']:
                    source = result.get('source', '')
                    if source:
                        migrated_files.add(source)
        
        return migrated_files
    
    def get_redundant_files(self) -> List[Path]:
        """Get list of redundant files that should be cleaned up."""
        redundant_files = []
        migrated_files = self.get_migrated_files()
        
        # Files that should be kept (not redundant)
        keep_files = {
            'start_refactoring.py',
            'cleanup_redundant_files.py',
            '.env',
            '.gitignore',
            'pytest.ini',
            'requirements.txt',
            'setup.py'
        }
        
        # Directories that should be kept
        keep_dirs = {
            'new_structure',
            'analysis_reports',
            'backup_before_migration_20250720_151603',
            'tools',
            '.cursor',
            '.vscode',
            '.pytest_cache'
        }
        
        # Check all files in project root
        for item in self.project_root.iterdir():
            if item.is_file():
                # Skip files that should be kept
                if item.name in keep_files:
                    continue
                
                # Skip hidden files
                if item.name.startswith('.'):
                    continue
                
                # Check if file was migrated
                if item.name in migrated_files:
                    redundant_files.append(item)
                    print(f"  Found redundant file: {item.name} (already migrated)")
                elif item.suffix in ['.ps1', '.sh', '.py', '.js']:
                    # Check if similar file exists in new structure
                    if self._has_similar_file_in_new_structure(item):
                        redundant_files.append(item)
                        print(f"  Found redundant file: {item.name} (similar file in new structure)")
            
            elif item.is_dir():
                # Skip directories that should be kept
                if item.name in keep_dirs:
                    continue
                
                # Check if directory contains migrated files
                if self._is_redundant_directory(item):
                    redundant_files.append(item)
                    print(f"  Found redundant directory: {item.name}")
        
        return redundant_files
    
    def _has_similar_file_in_new_structure(self, file_path: Path) -> bool:
        """Check if a similar file exists in the new structure."""
        # Check scripts directories
        script_dirs = [
            self.new_structure / "scripts" / "windows",
            self.new_structure / "scripts" / "macos",
            self.new_structure / "scripts" / "cross-platform"
        ]
        
        for script_dir in script_dirs:
            if script_dir.exists():
                for script_file in script_dir.glob("*"):
                    if script_file.name.lower() == file_path.name.lower():
                        return True
        
        # Check src directories
        src_dirs = [
            self.new_structure / "src" / "classifiers",
            self.new_structure / "src" / "processors",
            self.new_structure / "src" / "encoders",
            self.new_structure / "src" / "mergers",
            self.new_structure / "src" / "utils",
            self.new_structure / "src" / "config"
        ]
        
        for src_dir in src_dirs:
            if src_dir.exists():
                for src_file in src_dir.glob("*"):
                    if src_file.name.lower() == file_path.name.lower():
                        return True
        
        return False
    
    def _is_redundant_directory(self, dir_path: Path) -> bool:
        """Check if a directory is redundant."""
        # Check if directory contains only migrated files
        migrated_files = self.get_migrated_files()
        
        for item in dir_path.rglob("*"):
            if item.is_file():
                if item.name not in migrated_files:
                    return False
        
        return True
    
    def cleanup(self, dry_run: bool = True) -> None:
        """Clean up redundant files."""
        print("🔍 Scanning for redundant files...")
        redundant_files = self.get_redundant_files()
        
        if not redundant_files:
            print("✅ No redundant files found!")
            return
        
        print(f"\n📋 Found {len(redundant_files)} redundant files/directories:")
        for file_path in redundant_files:
            print(f"  - {file_path.name}")
        
        if dry_run:
            print(f"\n🔍 Dry run mode - no files will be deleted")
            print("Run with --execute to actually delete files")
            return
        
        # Create backup of redundant files
        backup_dir = self.project_root / "cleanup_backup"
        backup_dir.mkdir(exist_ok=True)
        
        print(f"\n🗑️  Moving redundant files to backup: {backup_dir}")
        
        for file_path in redundant_files:
            try:
                backup_path = backup_dir / file_path.name
                
                # Handle name conflicts
                counter = 1
                while backup_path.exists():
                    backup_path = backup_dir / f"{file_path.stem}_{counter}{file_path.suffix}"
                    counter += 1
                
                if file_path.is_file():
                    shutil.move(str(file_path), str(backup_path))
                else:
                    shutil.move(str(file_path), str(backup_path))
                
                print(f"  ✅ Moved: {file_path.name} -> {backup_path.name}")
                
            except Exception as e:
                print(f"  ❌ Error moving {file_path.name}: {e}")
        
        print(f"\n✅ Cleanup completed! Backup saved to: {backup_dir}")


def main():
    """Main function."""
    import argparse
    
    parser = argparse.ArgumentParser(description="Clean up redundant files after refactoring")
    parser.add_argument("--execute", action="store_true", help="Actually delete files (default is dry run)")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    
    args = parser.parse_args()
    
    project_root = Path(args.project_root).resolve()
    
    if not project_root.exists():
        print(f"❌ Project root does not exist: {project_root}")
        return
    
    print("🧹 VR Video Processing Pipeline - Redundant File Cleanup")
    print("=" * 60)
    print(f"Project root: {project_root}")
    print(f"Mode: {'Execute' if args.execute else 'Dry Run'}")
    print()
    
    cleaner = RedundantFileCleaner(project_root)
    cleaner.cleanup(dry_run=not args.execute)


if __name__ == "__main__":
    main() 