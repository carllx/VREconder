#!/usr/bin/env bash

# 批量执行 MergeDash_legcy.sh 处理子文件夹的视频

# 检查命令行参数
if [ $# -eq 0 ]; then
    echo "请提供父文件夹路径"
    echo "用法: $0 <父文件夹路径>"
    exit 1
fi

# 定义变量
parent_dir="$1"
merge_script="/Volumes/Media/VR/VR_Video_Processing/app/MergeDash_legcy.sh"
log_file="/Volumes/Media/VR/VR_Video_Processing/app/batch_merge_$(date +%Y%m%d_%H%M%S).log"

# 检查父文件夹是否存在
if [ ! -d "$parent_dir" ]; then
    echo "错误：父文件夹不存在: $parent_dir"
    exit 1
fi

# 检查合并脚本是否存在且可执行
if [ ! -x "$merge_script" ]; then
    echo "错误：合并脚本不存在或不可执行: $merge_script"
    exit 1
fi

# 初始化日志文件
echo "批量处理开始时间: $(date)" > "$log_file"
echo "父文件夹: $parent_dir" >> "$log_file"
echo "----------------------------------------" >> "$log_file"

# 统计变量
total_folders=0
successful_folders=0
failed_folders=0

# 查找所有子文件夹（只查找第一级子文件夹）
echo "正在扫描子文件夹..."
subfolders=()
for folder in "$parent_dir"/*; do
    if [ -d "$folder" ]; then
        # 检查是否包含 m4s 文件
        if find "$folder" -maxdepth 1 -name "*.m4s" | grep -q .; then
            subfolders+=("$folder")
            ((total_folders++))
        fi
    fi
done

echo "找到 $total_folders 个包含 m4s 文件的子文件夹"
echo "找到 $total_folders 个包含 m4s 文件的子文件夹" >> "$log_file"

# 处理每个子文件夹
for folder in "${subfolders[@]}"; do
    folder_name=$(basename "$folder")
    echo ""
    echo "=========================================="
    echo "正在处理: $folder_name ($(date))"
    echo "=========================================="
    echo "" >> "$log_file"
    echo "处理文件夹: $folder_name" >> "$log_file"
    echo "开始时间: $(date)" >> "$log_file"
    
    # 执行合并脚本
    if "$merge_script" "$folder" >> "$log_file" 2>&1; then
        echo "✅ 成功处理: $folder_name"
        echo "状态: 成功" >> "$log_file"
        ((successful_folders++))
    else
        echo "❌ 处理失败: $folder_name"
        echo "状态: 失败" >> "$log_file"
        ((failed_folders++))
    fi
    
    echo "完成时间: $(date)" >> "$log_file"
    echo "----------------------------------------" >> "$log_file"
done

# 输出统计信息
echo ""
echo "=========================================="
echo "批量处理完成"
echo "总文件夹数: $total_folders"
echo "成功处理: $successful_folders"
echo "处理失败: $failed_folders"
echo "日志文件: $log_file"
echo "=========================================="

# 将统计信息写入日志
echo "" >> "$log_file"
echo "批量处理统计" >> "$log_file"
echo "总文件夹数: $total_folders" >> "$log_file"
echo "成功处理: $successful_folders" >> "$log_file"
echo "处理失败: $failed_folders" >> "$log_file"
echo "完成时间: $(date)" >> "$log_file"

# 如果有失败的文件夹，返回非零状态码
if [ $failed_folders -gt 0 ]; then
    exit 1
fi

exit 0