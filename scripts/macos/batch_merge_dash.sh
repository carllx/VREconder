#!/usr/bin/env bash

# VR Video DASH Batch Merger - Improved Version
# Batch processes folders containing DASH video segments using the improved merge_dash.sh
# Author: Improved version based on legacy scripts
# Version: 2.0

set -u

# Configuration
readonly SCRIPT_NAME="$(basename "$0")"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DEFAULT_LOG_DIR="$HOME/Library/Logs/VRVideoProcessing"
readonly MERGE_SCRIPT="$SCRIPT_DIR/merge_dash.sh"

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color

# Global variables
LOG_FILE=""
VERBOSE=false
DRY_RUN=false
PARALLEL_JOBS=1

# Logging functions
log() {
    local level="$1"
    shift
    local message="$*"
    local timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
    
    case "$level" in
        "ERROR")
            echo -e "${RED}[ERROR]${NC} $message" >&2
            ;;
        "WARN")
            echo -e "${YELLOW}[WARN]${NC} $message" >&2
            ;;
        "INFO")
            echo -e "${GREEN}[INFO]${NC} $message"
            ;;
        "DEBUG")
            if [[ "$VERBOSE" == true ]]; then
                echo -e "${BLUE}[DEBUG]${NC} $message"
            fi
            ;;
    esac
    
    if [[ -n "$LOG_FILE" ]]; then
        echo "[$timestamp] [$level] $message" >> "$LOG_FILE"
    fi
}

# Error handling
error_exit() {
    log "ERROR" "$1"
    exit "${2:-1}"
}

# Check dependencies
check_dependencies() {
    local deps=("find" "bc")
    local missing=()
    
    for dep in "${deps[@]}"; do
        if ! command -v "$dep" &> /dev/null; then
            missing+=("$dep")
        fi
    done
    
    if [[ ${#missing[@]} -gt 0 ]]; then
        error_exit "Missing dependencies: ${missing[*]}"
    fi
    
    # Check if merge script exists and is executable
    if [[ ! -f "$MERGE_SCRIPT" ]]; then
        error_exit "Merge script not found: $MERGE_SCRIPT"
    fi
    
    if [[ ! -x "$MERGE_SCRIPT" ]]; then
        error_exit "Merge script is not executable: $MERGE_SCRIPT"
    fi
}

# Validate path
validate_path() {
    local path="$1"
    local type="$2"  # "file" or "directory"
    
    if [[ ! -e "$path" ]]; then
        error_exit "Path does not exist: $path"
    fi
    
    if [[ "$type" == "directory" && ! -d "$path" ]]; then
        error_exit "Path is not a directory: $path"
    elif [[ "$type" == "file" && ! -f "$path" ]]; then
        error_exit "Path is not a file: $path"
    fi
}

# Setup logging
setup_logging() {
    local log_dir="${LOG_DIR:-$DEFAULT_LOG_DIR}"
    mkdir -p "$log_dir"
    LOG_FILE="$log_dir/batch_merge_dash_$(date +%Y%m%d_%H%M%S).log"
    log "INFO" "Logging to: $LOG_FILE"
}

# Process single folder using the improved merge script
process_folder_with_merge_script() {
    local folder_dir="$1"
    local folder_name="$(basename "$folder_dir")"
    
    log "INFO" "Processing folder: $folder_name"
    
    # Prepare merge script arguments
    local merge_args=()
    
    if [[ "$VERBOSE" == true ]]; then
        merge_args+=("--verbose")
    fi
    
    if [[ "$DRY_RUN" == true ]]; then
        merge_args+=("--dry-run")
    fi
    
    # Use custom log directory if set
    if [[ -n "${LOG_DIR:-}" ]]; then
        merge_args+=("--log-dir" "$LOG_DIR")
    fi
    
    merge_args+=("$folder_dir")
    
    log "DEBUG" "Executing: $MERGE_SCRIPT ${merge_args[*]}"
    
    # Execute merge script and capture both stdout and stderr
    local temp_log="$(mktemp)"
    local exit_code=0
    
    if [[ "$DRY_RUN" == true ]]; then
        log "INFO" "[DRY RUN] Would execute: $MERGE_SCRIPT ${merge_args[*]}"
        echo "[DRY RUN] Simulated processing of $folder_name" > "$temp_log"
    else
        "$MERGE_SCRIPT" "${merge_args[@]}" >"$temp_log" 2>&1 || exit_code=$?
    fi
    
    # Log the output from merge script
    if [[ -s "$temp_log" ]]; then
        log "DEBUG" "Merge script output for $folder_name:"
        while IFS= read -r line; do
            log "DEBUG" "  $line"
        done < "$temp_log"
    fi
    
    # Clean up temp log
    rm -f "$temp_log"
    
    return $exit_code
}

# Batch process folders
batch_process() {
    local parent_dir="$1"
    local total_folders=0
    local successful_folders=0
    local failed_folders=0
    local skipped_folders=0
    
    log "INFO" "Scanning for folders with m4s files in: $parent_dir"
    
    local folders=()
    while IFS= read -r -d '' folder; do
        # Skip the parent directory itself
        if [[ "$folder" == "$parent_dir" ]]; then
            continue
        fi
        
        # Check if folder contains m4s files
        if find "$folder" -maxdepth 1 -name "*.m4s" | head -1 | grep -q .; then
            # Check if output already exists
            local folder_name="$(basename "$folder")"
            local potential_output="$folder/$folder_name.mp4"
            
            if [[ -f "$potential_output" ]]; then
                log "WARN" "Output already exists for $folder_name: $potential_output"
                ((skipped_folders++))
                continue
            fi
            
            folders+=("$folder")
            ((total_folders++))
        fi
    done < <(find "$parent_dir" -maxdepth 1 -type d -print0)
    
    log "INFO" "Found $total_folders folders to process"
    if [[ $skipped_folders -gt 0 ]]; then
        log "INFO" "Skipped $skipped_folders folders (output already exists)"
    fi
    
    if [[ $total_folders -eq 0 ]]; then
        log "WARN" "No folders with m4s files found (or all already processed)"
        return 0
    fi
    
    # Process folders
    local current_folder=0
    for folder in "${folders[@]}"; do
        ((current_folder++))
        local folder_name="$(basename "$folder")"
        local progress_pct=$(( (current_folder * 100) / total_folders ))
        
        log "INFO" "Processing folder ($current_folder/$total_folders - ${progress_pct}%): $folder_name"
        
        local start_time="$(date '+%s')"
        
        if process_folder_with_merge_script "$folder"; then
            local end_time="$(date '+%s')"
            local duration=$((end_time - start_time))
            log "INFO" "✅ Successfully processed: $folder_name (${duration}s)"
            ((successful_folders++))
        else
            local end_time="$(date '+%s')"
            local duration=$((end_time - start_time))
            log "ERROR" "❌ Failed to process: $folder_name (${duration}s)"
            ((failed_folders++))
        fi
    done
    
    # Summary
    log "INFO" "=========================================="
    log "INFO" "Batch processing complete:"
    log "INFO" "  Total folders found: $((total_folders + skipped_folders))"
    log "INFO" "  Processed: $total_folders"
    log "INFO" "  Successful: $successful_folders"
    log "INFO" "  Failed: $failed_folders"
    log "INFO" "  Skipped: $skipped_folders"
    log "INFO" "  Success rate: $(( (successful_folders * 100) / (total_folders > 0 ? total_folders : 1) ))%"
    log "INFO" "=========================================="
    
    return $([[ $failed_folders -eq 0 ]])
}

# Usage information
show_usage() {
    cat << EOF
Usage: $SCRIPT_NAME [OPTIONS] <parent_directory>

Batch process all subdirectories containing DASH video segments (.m4s files).

Arguments:
    parent_directory    Parent directory containing subdirectories with m4s files

Options:
    -v, --verbose       Enable verbose output
    -n, --dry-run       Show what would be done without executing
    -j, --jobs N        Number of parallel jobs (future feature, default: 1)
    --log-dir DIR       Custom log directory (default: $DEFAULT_LOG_DIR)
    -h, --help          Show this help message

Examples:
    $SCRIPT_NAME /path/to/parent/folder
    $SCRIPT_NAME --verbose /path/to/parent/folder
    $SCRIPT_NAME --dry-run /path/to/parent/folder

Note:
    This script uses the improved merge_dash.sh script for processing individual folders.
    Make sure merge_dash.sh is in the same directory as this script.

EOF
}

# Main function
main() {
    local parent_dir=""
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -v|--verbose)
                VERBOSE=true
                shift
                ;;
            -n|--dry-run)
                DRY_RUN=true
                shift
                ;;
            -j|--jobs)
                if [[ -n "${2:-}" ]] && [[ "$2" =~ ^[0-9]+$ ]]; then
                    PARALLEL_JOBS="$2"
                    log "WARN" "Parallel jobs feature not yet implemented, using sequential processing"
                    shift 2
                else
                    error_exit "Invalid jobs count: ${2:-}"
                fi
                ;;
            --log-dir)
                if [[ -n "${2:-}" ]]; then
                    LOG_DIR="$2"
                    shift 2
                else
                    error_exit "Log directory not specified"
                fi
                ;;
            -h|--help)
                show_usage
                exit 0
                ;;
            -*)
                error_exit "Unknown option: $1"
                ;;
            *)
                if [[ -z "$parent_dir" ]]; then
                    parent_dir="$1"
                else
                    error_exit "Multiple directories specified"
                fi
                shift
                ;;
        esac
    done
    
    # Validate arguments
    if [[ -z "$parent_dir" ]]; then
        show_usage
        error_exit "No parent directory specified"
    fi
    
    validate_path "$parent_dir" "directory"
    check_dependencies
    setup_logging
    
    log "INFO" "Starting VR Video DASH Batch Merger v2.0"
    log "INFO" "Parent directory: $parent_dir"
    log "INFO" "Merge script: $MERGE_SCRIPT"
    log "INFO" "Dry run: $DRY_RUN"
    log "INFO" "Verbose: $VERBOSE"
    
    # Execute batch processing
    batch_process "$parent_dir"
    
    local exit_code=$?
    log "INFO" "Batch processing completed with exit code: $exit_code"
    exit $exit_code
}

# Execute main function with all arguments
main "$@"