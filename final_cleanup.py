#!/usr/bin/env python3
"""
Final cleanup script to remove redundant directories after refactoring.
"""

import shutil
from pathlib import Path


def cleanup_redundant_directories():
    """Clean up redundant directories that are now in new_structure."""
    project_root = Path('.')
    
    # Directories that are now redundant (moved to new_structure)
    redundant_dirs = [
        'docs',  # moved to new_structure/docs
        'scripts',  # moved to new_structure/scripts
        'src',  # moved to new_structure/src
        'config',  # moved to new_structure/config
        'examples',  # moved to new_structure/templates
        'test_output'  # moved to new_structure/templates
    ]
    
    # Files that are redundant
    redundant_files = [
        '.DS_Store',
        'setup.py'  # moved to new_structure/setup.py
    ]
    
    print("🧹 Final cleanup of redundant directories and files")
    print("=" * 50)
    
    # Clean up redundant directories
    for dir_name in redundant_dirs:
        dir_path = project_root / dir_name
        if dir_path.exists():
            try:
                # Move to backup first
                backup_path = project_root / f"backup_{dir_name}"
                if backup_path.exists():
                    shutil.rmtree(backup_path)
                
                shutil.move(str(dir_path), str(backup_path))
                print(f"✅ Moved directory: {dir_name} -> backup_{dir_name}")
            except Exception as e:
                print(f"❌ Error moving {dir_name}: {e}")
    
    # Clean up redundant files
    for file_name in redundant_files:
        file_path = project_root / file_name
        if file_path.exists():
            try:
                # Move to backup first
                backup_path = project_root / f"backup_{file_name}"
                if backup_path.exists():
                    backup_path.unlink()
                
                shutil.move(str(file_path), str(backup_path))
                print(f"✅ Moved file: {file_name} -> backup_{file_name}")
            except Exception as e:
                print(f"❌ Error moving {file_name}: {e}")
    
    print("\n✅ Final cleanup completed!")


if __name__ == "__main__":
    cleanup_redundant_directories() 