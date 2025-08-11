#!/usr/bin/env bash

# VR Video DASH Merger - Improved Version
# Combines functionality of MergeDash_legcy.sh and batch_merge_dash.sh
# Author: Improved version based on legacy scripts
# Version: 2.0

# set -euo pipefail  # Disable for complex processing
set -u

# Configuration
readonly SCRIPT_NAME="$(basename "$0")"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DEFAULT_LOG_DIR="$HOME/Library/Logs/VRVideoProcessing"
readonly TEMP_SUFFIX="vr_processing_$$"

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
CLEANUP_ON_ERROR=true

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

# Cleanup function
cleanup_temp() {
    local temp_dir="$1"
    if [[ -d "$temp_dir" ]]; then
        log "DEBUG" "Cleaning up temporary directory: $temp_dir"
        rm -rf "$temp_dir" || log "WARN" "Failed to clean up temp directory: $temp_dir"
    fi
}

# Check dependencies
check_dependencies() {
    local deps=("ffmpeg" "bc" "find" "sort")
    local missing=()
    
    for dep in "${deps[@]}"; do
        if ! command -v "$dep" &> /dev/null; then
            missing+=("$dep")
        fi
    done
    
    if [[ ${#missing[@]} -gt 0 ]]; then
        error_exit "Missing dependencies: ${missing[*]}"
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
    LOG_FILE="$log_dir/dash_merge_$(date +%Y%m%d_%H%M%S).log"
    log "INFO" "Logging to: $LOG_FILE"
}

# Parse m4s filename
parse_m4s_filename() {
    local filename="$1"
    local -n result_ref="$2"
    
    # Pattern: P<identifier>-<start>-<end>-<number>.m4s
    if [[ "$filename" =~ ^P([0-9]+)-([0-9.]+)-([0-9.]+)-[0-9]+\.m4s$ ]]; then
        result_ref[identifier]="${BASH_REMATCH[1]}"
        result_ref[start]="${BASH_REMATCH[2]}"
        result_ref[end]="${BASH_REMATCH[3]}"
        return 0
    fi
    return 1
}

# Validate numeric value
is_valid_number() {
    local num="$1"
    [[ "$num" =~ ^[0-9]+(\.[0-9]+)?$ ]] && (( $(echo "$num > 0" | bc -l) ))
}

# Enhanced binary file merging with retry mechanism
merge_binary_files() {
    local target_file="$1"
    local source_file="$2"
    local max_retries=3
    local retry_count=0
    
    # Check if source file exists and is readable
    if [[ ! -f "$source_file" || ! -r "$source_file" ]]; then
        log "ERROR" "Source file not found or not readable: $source_file"
        return 1
    fi
    
    # Retry loop for file locking issues
    while [[ $retry_count -lt $max_retries ]]; do
        local temp_file="$(mktemp)"
        
        # Try to merge files
        if [[ -f "$target_file" ]]; then
            if cat "$target_file" "$source_file" > "$temp_file" 2>/dev/null; then
                # Atomic move operation
                if mv "$temp_file" "$target_file" 2>/dev/null; then
                    return 0
                fi
            fi
        else
            if cat "$source_file" > "$temp_file" 2>/dev/null; then
                if mv "$temp_file" "$target_file" 2>/dev/null; then
                    return 0
                fi
            fi
        fi
        
        # Cleanup temp file on failure
        rm -f "$temp_file" 2>/dev/null
        
        ((retry_count++))
        if [[ $retry_count -lt $max_retries ]]; then
            log "WARN" "Merge attempt $retry_count failed, retrying..."
            sleep 0.2
        fi
    done
    
    log "ERROR" "Failed to merge files after $max_retries attempts"
    return 1
}

# Audio stream repair function with multiple strategies
repair_audio_stream() {
    local input_file="$1"
    local output_file="$2"
    local duration="$3"
    local has_init="$4"  # Whether init.mp4 was available
    
    if ! command -v ffmpeg &> /dev/null; then
        log "ERROR" "ffmpeg not found"
        return 1
    fi
    
    # For files without init.mp4, try different strategies
    if [[ "$has_init" != "true" ]]; then
        log "DEBUG" "Processing m4s files without init.mp4"
        
        # Strategy 1: Try to detect format and process
        log "DEBUG" "Trying strategy: Auto-detect format"
        if ffmpeg -y -i "$input_file" -c copy -t "$duration" "$output_file" 2>/dev/null; then
            log "DEBUG" "Strategy 'Auto-detect format' succeeded"
            return 0
        fi
        
        # Strategy 2: Force MP4 format
        log "DEBUG" "Trying strategy: Force MP4 format"
        if ffmpeg -y -f mp4 -i "$input_file" -c copy -t "$duration" "$output_file" 2>/dev/null; then
            log "DEBUG" "Strategy 'Force MP4 format' succeeded"
            return 0
        fi
        
        # Strategy 3: Re-encode everything
        log "DEBUG" "Trying strategy: Full re-encode"
        if ffmpeg -y -i "$input_file" -c:v libx264 -c:a aac -t "$duration" "$output_file" 2>/dev/null; then
            log "DEBUG" "Strategy 'Full re-encode' succeeded"
            return 0
        fi
    fi
    
    # Original strategies for files with init.mp4
    # Strategy 1: Discard corrupt packets
    log "DEBUG" "Trying strategy: Discard corrupt packets"
    if ffmpeg -y -i "$input_file" -ss 0 -c copy -fflags +discardcorrupt -ignore_unknown -t "$duration" "$output_file" 2>/dev/null; then
        log "DEBUG" "Strategy 'Discard corrupt packets' succeeded"
        return 0
    fi
    
    # Strategy 2: Re-encode audio
    log "DEBUG" "Trying strategy: Re-encode audio"
    if ffmpeg -y -i "$input_file" -ss 0 -c:v copy -c:a aac -avoid_negative_ts make_zero -fflags +discardcorrupt -t "$duration" "$output_file" 2>/dev/null; then
        log "DEBUG" "Strategy 'Re-encode audio' succeeded"
        return 0
    fi
    
    # Strategy 3: Video only
    log "DEBUG" "Trying strategy: Video only"
    if ffmpeg -y -i "$input_file" -ss 0 -c:v copy -an -t "$duration" "$output_file" 2>/dev/null; then
        log "DEBUG" "Strategy 'Video only' succeeded"
        return 0
    fi
    
    # Strategy 4: Loose parameters
    log "DEBUG" "Trying strategy: Loose parameters"
    if ffmpeg -y -i "$input_file" -ss 0 -c:v copy -c:a aac -strict experimental -fflags +discardcorrupt+genpts -t "$duration" "$output_file" 2>/dev/null; then
        log "DEBUG" "Strategy 'Loose parameters' succeeded"
        return 0
    fi
    
    log "ERROR" "All audio repair strategies failed"
    return 1
}

# Final merge with multiple strategies
final_merge_with_strategies() {
    local concat_file="$1"
    local output_file="$2"
    
    if ! command -v ffmpeg &> /dev/null; then
        log "ERROR" "ffmpeg not found"
        return 1
    fi
    
    # Strategy 1: Standard concat
    log "DEBUG" "Trying final merge strategy: Standard concat"
    if ffmpeg -y -f concat -safe 0 -i "$concat_file" -c copy -fflags +discardcorrupt -ignore_unknown "$output_file" 2>/dev/null; then
        log "DEBUG" "Final merge strategy 'Standard concat' succeeded"
        return 0
    fi
    
    # Strategy 2: Re-encode audio
    log "DEBUG" "Trying final merge strategy: Re-encode audio"
    if ffmpeg -y -f concat -safe 0 -i "$concat_file" -c:v copy -c:a aac -avoid_negative_ts make_zero -fflags +discardcorrupt "$output_file" 2>/dev/null; then
        log "DEBUG" "Final merge strategy 'Re-encode audio' succeeded"
        return 0
    fi
    
    # Strategy 3: Video only
    log "DEBUG" "Trying final merge strategy: Video only"
    if ffmpeg -y -f concat -safe 0 -i "$concat_file" -c:v copy -an "$output_file" 2>/dev/null; then
        log "DEBUG" "Final merge strategy 'Video only' succeeded"
        return 0
    fi
    
    log "ERROR" "All final merge strategies failed"
    return 1
}

# Process single folder
process_folder() {
    local folder_dir="$1"
    local folder_name="$(basename "$folder_dir")"
    local folder_temp="$folder_dir/temp_$TEMP_SUFFIX"
    local output_file="$folder_dir/$folder_name.mp4"
    
    log "INFO" "Processing folder: $folder_name"
    
    # Check if output already exists
    if [[ -f "$output_file" ]]; then
        log "WARN" "Output file already exists: $output_file"
        read -p "Overwrite? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log "INFO" "Skipping folder: $folder_name"
            return 0
        fi
    fi
    
    # Create temp directory
    mkdir -p "$folder_temp"
    trap "cleanup_temp '$folder_temp'" EXIT
    
    # Find init file
    local init_file
    init_file="$(find "$folder_dir" -maxdepth 1 -type f -name "init.mp4" | head -1)"
    if [[ -z "$init_file" ]]; then
        log "WARN" "No init.mp4 file found in $folder_dir"
    fi
    
    # Process m4s files
    declare -A start_for_identifier end_for_identifier
    declare -a identifiers
    local file_count=0
    
    log "INFO" "Preloading file information..."
    local all_m4s_files=()
    while IFS= read -r -d '' file; do
        all_m4s_files+=("$file")
    done < <(find "$folder_dir" -maxdepth 1 -type f -name "*.m4s" -print0)
    
    log "INFO" "Found ${#all_m4s_files[@]} m4s files"
    
    # Declare parsed_info once outside the loop
    declare -A parsed_info
    
    for file in "${all_m4s_files[@]}"; do
        local filename="$(basename "$file")"
        # Clear the associative array for each iteration
        unset parsed_info
        declare -A parsed_info
        
        log "DEBUG" "Processing file: $filename"
        
        if parse_m4s_filename "$filename" parsed_info; then
            local identifier="${parsed_info[identifier]}"
            local start="${parsed_info[start]}"
            local end="${parsed_info[end]}"
            
            log "DEBUG" "Parsed: $filename -> ID:$identifier, Start:$start, End:$end"
            
            if ! is_valid_number "$start" || ! is_valid_number "$end"; then
                log "WARN" "Invalid timing values in $filename: start=$start, end=$end"
                continue
            fi
            
            # Track identifiers
            if [[ -z "${start_for_identifier[$identifier]:-}" ]]; then
                identifiers+=("$identifier")
                log "DEBUG" "New identifier found: $identifier"
            fi
            
            # Update start/end times - add debug around bc calls
            log "DEBUG" "Checking start time: current=${start_for_identifier[$identifier]:-}, new=$start"
            if [[ -z "${start_for_identifier[$identifier]:-}" ]] || \
               (( $(echo "${start_for_identifier[$identifier]} > $start" | bc -l) )); then
                start_for_identifier[$identifier]="$start"
                log "DEBUG" "Updated start time for $identifier: $start"
            fi
            
            log "DEBUG" "Checking end time: current=${end_for_identifier[$identifier]:-}, new=$end"
            if [[ -z "${end_for_identifier[$identifier]:-}" ]] || \
               (( $(echo "${end_for_identifier[$identifier]} < $end" | bc -l) )); then
                end_for_identifier[$identifier]="$end"
                log "DEBUG" "Updated end time for $identifier: $end"
            fi
            
            ((file_count++))
            log "DEBUG" "File count now: $file_count"
        else
            log "DEBUG" "Skipping file with unrecognized format: $filename"
        fi
        log "DEBUG" "Completed processing of: $filename"
    done
    
    log "DEBUG" "Finished processing all files. Total processed: $file_count"
    
    # Skip pre-grouping - process identifiers directly like legacy script
    log "DEBUG" "Will process identifiers: ${identifiers[*]}"
    
    if [[ $file_count -eq 0 ]]; then
        log "WARN" "No valid m4s files found in $folder_dir"
        return 1
    fi
    
    log "INFO" "Found $file_count m4s files with ${#identifiers[@]} unique identifiers"
    
    # Process each identifier
    local concat_file="$folder_temp/concat.txt"
    > "$concat_file"
    
    local link_dir="$folder_temp/links"
    mkdir -p "$link_dir"
    
    # Sort identifiers by start time, not by ID number, for proper chronological order
    local sorted_identifiers=()
    
    # Create array of identifier:start_time pairs
    local id_time_pairs=()
    for identifier in "${identifiers[@]}"; do
        id_time_pairs+=("${identifier}:${start_for_identifier[$identifier]}")
    done
    
    # Sort by start time (second field after colon)
    local sorted_pairs
    IFS=$'\n' sorted_pairs=($(printf '%s\n' "${id_time_pairs[@]}" | sort -t: -k2 -n))
    
    # Extract sorted identifiers
    for pair in "${sorted_pairs[@]}"; do
        sorted_identifiers+=("${pair%:*}")
    done
    
    log "INFO" "Processing identifiers in chronological order: ${sorted_identifiers[*]}"
    for identifier in "${sorted_identifiers[@]}"; do
        log "INFO" "  Part $identifier: ${start_for_identifier[$identifier]}s - ${end_for_identifier[$identifier]}s"
    done
    
    local current_part=0
    local total_parts=${#sorted_identifiers[@]}
    
    for identifier in "${sorted_identifiers[@]}"; do
        ((current_part++))
        local start_time="${start_for_identifier[$identifier]}"
        local end_time="${end_for_identifier[$identifier]}"
        local duration
        duration="$(echo "$end_time - $start_time" | bc -l)"
        local progress_pct=$(( (current_part * 100) / total_parts ))
        
        log "INFO" "Processing identifier $identifier ($current_part/$total_parts - ${progress_pct}%): $start_time -> $end_time (duration: $duration)"
        
        if ! is_valid_number "$duration"; then
            log "ERROR" "Invalid duration for identifier $identifier: $duration"
            return 1
        fi
        
        # Create temporary merged file
        local temp_pre="$folder_temp/pre_${identifier}.mp4"
        local temp_final="$folder_temp/render_${identifier}.mp4"
        
        # Remove existing temp file if present
        rm -f "$temp_pre"
        
        # Initialize with init file if available, otherwise start with first m4s file
        if [[ -n "$init_file" ]]; then
            log "DEBUG" "(Part$identifier) Adding init file"
            if ! cp "$init_file" "$temp_pre"; then
                log "ERROR" "Failed to copy init file"
                return 1
            fi
        else
            # Without init.mp4, create empty file to start
            > "$temp_pre"
            log "DEBUG" "(Part$identifier) No init file - starting with empty base"
        fi
        
        # Use legacy approach: find and sort files for this identifier
        log "DEBUG" "Finding files for identifier $identifier"
        local processed_count=0
        
        # Find and process files in sorted order (like legacy script)
        while IFS= read -r -d '' file; do
            ((processed_count++))
            local filename="$(basename "$file")"
            log "DEBUG" "(Part$identifier) Adding m4s file [$processed_count]: $filename"
            
            # Use enhanced binary merge function
            if ! merge_binary_files "$temp_pre" "$file"; then
                log "ERROR" "Failed to merge file: $file"
                return 1
            fi
        done < <(find "$folder_dir" -type f -name "P${identifier}*.m4s" -print0 | sort -z -V)
        
        if [[ ! -s "$temp_pre" ]]; then
            log "ERROR" "Temporary file is empty: $temp_pre"
            return 1
        fi
        
        # Process with enhanced audio repair
        local has_init_param="false"
        if [[ -n "$init_file" ]]; then
            has_init_param="true"
        fi
        
        log "DEBUG" "Running audio repair for identifier $identifier with duration $duration (init: $has_init_param)"
        if [[ "$DRY_RUN" == true ]]; then
            log "INFO" "[DRY RUN] Would process: repair_audio_stream '$temp_pre' '$temp_final' '$duration' '$has_init_param'"
            # Create dummy file with some content for dry run
            echo "dummy content for dry run" > "$temp_final"
        else
            if ! repair_audio_stream "$temp_pre" "$temp_final" "$duration" "$has_init_param"; then
                log "ERROR" "Audio repair failed for identifier $identifier"
                return 1
            fi
        fi
        
        if [[ ! -s "$temp_final" ]]; then
            log "ERROR" "Output file is empty: $temp_final"
            return 1
        fi
        
        # Create symlink for final concat
        local link_name="$link_dir/part_${identifier}.mp4"
        ln -sf "$(realpath "$temp_final")" "$link_name"
        echo "file '$link_name'" >> "$concat_file"
        
        # Cleanup intermediate file
        rm -f "$temp_pre"
    done
    
    # Final merge
    if [[ ! -s "$concat_file" ]]; then
        log "ERROR" "Concat file is empty"
        return 1
    fi
    
    log "INFO" "Merging ${#sorted_identifiers[@]} parts into final video"
    log "DEBUG" "Concat file contents:"
    if [[ "$VERBOSE" == true ]]; then
        cat "$concat_file" | while read -r line; do
            log "DEBUG" "  $line"
        done
    fi
    
    if [[ "$DRY_RUN" == true ]]; then
        log "INFO" "[DRY RUN] Would create: $output_file"
        # Create dummy output file for dry run
        echo "dummy final output for dry run" > "$output_file"
    else
        # Use enhanced final merge with multiple strategies
        if ! final_merge_with_strategies "$concat_file" "$output_file"; then
            log "ERROR" "All final merge strategies failed"
            return 1
        fi
        
        if [[ ! -s "$output_file" ]]; then
            log "ERROR" "Final output file is empty"
            return 1
        fi
        
        # Get file size for reporting
        local file_size
        if command -v stat &> /dev/null; then
            if [[ "$(uname)" == "Darwin" ]]; then
                file_size="$(stat -f%z "$output_file" 2>/dev/null || echo "unknown")"
            else
                file_size="$(stat -c%s "$output_file" 2>/dev/null || echo "unknown")"
            fi
            if [[ "$file_size" != "unknown" ]]; then
                local file_size_mb=$(( file_size / 1024 / 1024 ))
                log "INFO" "Successfully created: $output_file (${file_size_mb}MB)"
            else
                log "INFO" "Successfully created: $output_file"
            fi
        else
            log "INFO" "Successfully created: $output_file"
        fi
    fi
    
    return 0
}

# Batch process folders
batch_process() {
    local parent_dir="$1"
    local total_folders=0
    local successful_folders=0
    local failed_folders=0
    
    log "INFO" "Scanning for folders with m4s files in: $parent_dir"
    
    local folders=()
    while IFS= read -r -d '' folder; do
        if find "$folder" -maxdepth 1 -name "*.m4s" | head -1 | grep -q .; then
            folders+=("$folder")
            ((total_folders++))
        fi
    done < <(find "$parent_dir" -maxdepth 1 -type d -print0)
    
    log "INFO" "Found $total_folders folders with m4s files"
    
    if [[ $total_folders -eq 0 ]]; then
        log "WARN" "No folders with m4s files found"
        return 0
    fi
    
    # Process folders
    for folder in "${folders[@]}"; do
        local folder_name="$(basename "$folder")"
        log "INFO" "Processing folder ($((successful_folders + failed_folders + 1))/$total_folders): $folder_name"
        
        if process_folder "$folder"; then
            log "INFO" "✅ Successfully processed: $folder_name"
            ((successful_folders++))
        else
            log "ERROR" "❌ Failed to process: $folder_name"
            ((failed_folders++))
        fi
    done
    
    # Summary
    log "INFO" "Batch processing complete:"
    log "INFO" "  Total folders: $total_folders"
    log "INFO" "  Successful: $successful_folders"
    log "INFO" "  Failed: $failed_folders"
    
    return $([[ $failed_folders -eq 0 ]])
}

# Usage information
show_usage() {
    cat << EOF
Usage: $SCRIPT_NAME [OPTIONS] <path>

Process DASH video segments (.m4s files) into merged MP4 videos.

Arguments:
    path                Directory containing m4s files (single mode) or
                       parent directory containing subdirectories (batch mode)

Options:
    -b, --batch        Batch mode: process all subdirectories
    -v, --verbose      Enable verbose output
    -n, --dry-run      Show what would be done without executing
    -j, --jobs N       Number of parallel jobs (batch mode only, default: 1)
    --log-dir DIR      Custom log directory (default: $DEFAULT_LOG_DIR)
    --no-cleanup       Don't cleanup temp files on error
    -h, --help         Show this help message

Examples:
    $SCRIPT_NAME /path/to/video/folder
    $SCRIPT_NAME --batch /path/to/parent/folder
    $SCRIPT_NAME --verbose --dry-run /path/to/folder
    $SCRIPT_NAME --batch --jobs 4 /path/to/parent/folder

EOF
}

# Main function
main() {
    local batch_mode=false
    local target_path=""
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -b|--batch)
                batch_mode=true
                shift
                ;;
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
            --no-cleanup)
                CLEANUP_ON_ERROR=false
                shift
                ;;
            -h|--help)
                show_usage
                exit 0
                ;;
            -*)
                error_exit "Unknown option: $1"
                ;;
            *)
                if [[ -z "$target_path" ]]; then
                    target_path="$1"
                else
                    error_exit "Multiple paths specified"
                fi
                shift
                ;;
        esac
    done
    
    # Validate arguments
    if [[ -z "$target_path" ]]; then
        show_usage
        error_exit "No path specified"
    fi
    
    validate_path "$target_path" "directory"
    check_dependencies
    setup_logging
    
    log "INFO" "Starting VR Video DASH Merger v2.0"
    log "INFO" "Mode: $(if [[ "$batch_mode" == true ]]; then echo "Batch"; else echo "Single"; fi)"
    log "INFO" "Target: $target_path"
    log "INFO" "Dry run: $DRY_RUN"
    log "INFO" "Verbose: $VERBOSE"
    
    # Execute
    if [[ "$batch_mode" == true ]]; then
        batch_process "$target_path"
    else
        process_folder "$target_path"
    fi
    
    local exit_code=$?
    log "INFO" "Processing completed with exit code: $exit_code"
    exit $exit_code
}

# Execute main function with all arguments
main "$@"
