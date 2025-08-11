# VR Video DASH Merger - Improved Version

## Overview

`merge_dash_improved.sh` is an enhanced version that combines and improves upon the functionality of the original `MergeDash_legcy.sh` and `batch_merge_dash.sh` scripts. It processes DASH video segments (.m4s files) and merges them into complete MP4 videos.

## Key Improvements

### 🚀 Enhanced Features
- **Unified Script**: Single script handles both single folder and batch processing
- **Better Error Handling**: Comprehensive error checking and recovery
- **Improved Logging**: Structured logging with multiple levels and file output
- **Portable Design**: No hard-coded paths, works on any system
- **Dry Run Mode**: Preview operations without executing them
- **Progress Tracking**: Clear progress indicators and statistics
- **Input Validation**: Thorough validation of files, paths, and parameters

### 🛡️ Reliability Improvements
- **Safe Path Handling**: Proper handling of special characters in file paths
- **Atomic Operations**: Either all operations succeed or none are applied
- **Cleanup Management**: Automatic cleanup of temporary files
- **Dependency Checking**: Verifies required tools are available
- **Signal Handling**: Proper cleanup on interruption

### 🎯 User Experience
- **Colored Output**: Easy-to-read console output with color coding
- **Flexible Options**: Multiple command-line options for different use cases
- **Clear Documentation**: Built-in help and usage examples
- **Progress Feedback**: Real-time feedback on processing status

## Requirements

- **ffmpeg**: For video processing
- **bc**: For floating-point calculations
- **Standard Unix tools**: find, sort, etc.

## Usage

### Basic Syntax
```bash
./merge_dash_improved.sh [OPTIONS] <path>
```

### Single Folder Processing
Process one folder containing m4s files:
```bash
./merge_dash_improved.sh /path/to/video/folder
```

### Batch Processing
Process all subfolders containing m4s files:
```bash
./merge_dash_improved.sh --batch /path/to/parent/folder
```

### Advanced Usage Examples

#### Verbose output with dry run
```bash
./merge_dash_improved.sh --verbose --dry-run /path/to/folder
```

#### Batch processing with parallel jobs
```bash
./merge_dash_improved.sh --batch --jobs 4 /path/to/parent/folder
```

#### Custom log directory
```bash
./merge_dash_improved.sh --log-dir /custom/log/path /path/to/folder
```

## Command Line Options

| Option | Description |
|--------|-------------|
| `-b, --batch` | Enable batch mode to process multiple subdirectories |
| `-v, --verbose` | Enable verbose output for debugging |
| `-n, --dry-run` | Show what would be done without executing |
| `-j, --jobs N` | Number of parallel jobs (batch mode only) |
| `--log-dir DIR` | Custom log directory |
| `--no-cleanup` | Don't cleanup temp files on error (for debugging) |
| `-h, --help` | Show help message |

## File Structure Requirements

### Single Folder Mode
```
video_folder/
├── init.mp4                    # Optional initialization file
├── P1-0.0-10.5-001.m4s        # Video segments
├── P1-10.5-21.0-002.m4s
├── P2-0.0-15.2-001.m4s
└── ...
```

### Batch Mode
```
parent_folder/
├── video1/
│   ├── init.mp4
│   ├── P1-0.0-10.5-001.m4s
│   └── ...
├── video2/
│   ├── init.mp4
│   ├── P1-0.0-8.3-001.m4s
│   └── ...
└── ...
```

## Output

- **Single Mode**: Creates `folder_name.mp4` in the input folder
- **Batch Mode**: Creates `folder_name.mp4` in each processed subfolder
- **Logs**: Detailed logs saved to `~/Library/Logs/VRVideoProcessing/`

## Filename Pattern

The script expects m4s files to follow this naming pattern:
```
P<identifier>-<start_time>-<end_time>-<sequence>.m4s
```

Examples:
- `P1-0.0-10.5-001.m4s` - Part 1, from 0.0 to 10.5 seconds
- `P2-15.2-30.7-001.m4s` - Part 2, from 15.2 to 30.7 seconds

## Error Handling

The script includes comprehensive error handling:

- **Dependency Validation**: Checks for required tools
- **Path Validation**: Verifies input paths exist and are accessible
- **File Validation**: Ensures files are not empty and properly formatted
- **Process Validation**: Monitors ffmpeg operations for success
- **Cleanup**: Automatic cleanup of temporary files on exit or error

## Logging

Logs are automatically created with timestamps and saved to:
```
~/Library/Logs/VRVideoProcessing/dash_merge_YYYYMMDD_HHMMSS.log
```

Log levels include:
- **ERROR**: Critical errors that stop processing
- **WARN**: Warnings about non-critical issues
- **INFO**: General information about progress
- **DEBUG**: Detailed debugging information (requires --verbose)

## Comparison with Legacy Scripts

| Feature | Legacy Scripts | Improved Version |
|---------|---------------|------------------|
| **Single/Batch** | Separate scripts | Unified script |
| **Error Handling** | Basic | Comprehensive |
| **Logging** | Minimal | Structured with levels |
| **Path Safety** | Limited | Full special character support |
| **Dependencies** | Assumed | Validated |
| **Cleanup** | Manual | Automatic |
| **Progress** | Basic | Detailed with statistics |
| **Dry Run** | No | Yes |
| **Portability** | Hard-coded paths | Fully portable |
| **Documentation** | Minimal | Comprehensive |

## Troubleshooting

### Common Issues

1. **"Missing dependencies"**
   - Install ffmpeg: `brew install ffmpeg`
   - Ensure bc is available: `brew install bc`

2. **"Path does not exist"**
   - Verify the path is correct and accessible
   - Check file permissions

3. **"No valid m4s files found"**
   - Ensure files follow the correct naming pattern
   - Check that files are in the specified directory

4. **"FFmpeg failed"**
   - Check if input files are corrupted
   - Verify sufficient disk space
   - Review logs for detailed error messages

### Debug Mode

For troubleshooting, use:
```bash
./merge_dash_improved.sh --verbose --no-cleanup /path/to/folder
```

This will:
- Show detailed debug output
- Keep temporary files for inspection
- Log all operations to file

## Performance Tips

1. **Use SSD storage** for faster I/O operations
2. **Adjust parallel jobs** (`--jobs`) based on CPU cores
3. **Ensure sufficient RAM** for large video files
4. **Use local storage** rather than network drives when possible

## Migration from Legacy Scripts

To migrate from the old scripts:

1. **Replace calls** to `MergeDash_legcy.sh`:
   ```bash
   # Old
   ./MergeDash_legcy.sh /path/to/folder
   
   # New
   ./merge_dash_improved.sh /path/to/folder
   ```

2. **Replace calls** to `batch_merge_dash.sh`:
   ```bash
   # Old
   ./batch_merge_dash.sh /path/to/parent
   
   # New
   ./merge_dash_improved.sh --batch /path/to/parent
   ```

3. **Update hard-coded paths** in automation scripts
4. **Review log locations** - logs now go to `~/Library/Logs/VRVideoProcessing/`

## License

This script is provided as-is for VR video processing workflows.
