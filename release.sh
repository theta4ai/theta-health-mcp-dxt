#!/bin/bash

# Release 文件更新工具 - 增强版
# 支持直接输入数字版本号，自动添加v前缀，自动创建Release

# 配置默认参数
REPO="theta4ai/theta-health-mcp-dxt"
DEFAULT_FILE="theta-health-mcp-dxt.dxt"

# 解析参数
RAW_VERSION=${1:-""}
FILE_PATH=${2:-"./$DEFAULT_FILE"}

# 显示帮助信息
show_help() {
  echo "Release 文件更新工具"
  echo "用法: $0 [版本号] [可选文件路径]"
  echo "示例:"
  echo "  $0 0.0.4                  # 更新 v0.0.4 版本"
  echo "  $0 1.2.3 ./build/file.dxt # 更新 v1.2.3 版本并指定文件"
  exit 0
}

# 检查帮助请求
if [ "$1" == "-h" ] || [ "$1" == "--help" ]; then
  show_help
fi

# 检查必要参数
if [ -z "$RAW_VERSION" ]; then
  echo "错误：请指定版本号"
  show_help
fi

# 验证版本格式
if [[ ! "$RAW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && [[ ! "$RAW_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "错误：无效的版本格式 '$RAW_VERSION'，请使用类似 0.0.4 或 v0.0.4 的格式"
  exit 1
fi

# 自动添加 v 前缀（如果用户没有输入）
if [[ "$RAW_VERSION" != v* ]]; then
  TAG="v$RAW_VERSION"
else
  TAG="$RAW_VERSION"
fi

# 检查文件是否存在
if [ ! -f "$FILE_PATH" ]; then
  echo "错误：文件不存在 - $FILE_PATH"
  exit 2
fi

# 提取纯文件名
FILENAME=$(basename -- "$FILE_PATH")

echo "========================================"
echo "仓库:    $REPO"
echo "版本:    $TAG"
echo "文件:    $FILE_PATH"
echo "文件名:  $FILENAME"
echo "========================================"

# 检查 Release 是否存在
if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Release $TAG 不存在，正在创建..."
  gh release create "$TAG" --title "Release $TAG" --notes "自动创建" --generate-notes
fi

# 删除旧文件
echo -n "删除旧文件... "
gh release delete-asset "$TAG" "$FILENAME" --repo "$REPO" --yes 2>/dev/null || {
  echo "无旧文件可删除"
}

# 上传新文件
echo -n "上传新文件... "
gh release upload "$TAG" "$FILE_PATH" --repo "$REPO" || {
  echo "上传失败！请检查错误信息"
  exit 3
}
echo "完成"

# 生成下载链接
echo -e "\n\033[32m文件更新成功！\033[0m"
echo "下载链接："
echo "https://github.com/$REPO/releases/download/$TAG/$FILENAME"

# 添加校验文件（可选）
echo -n "生成校验文件... "
sha256sum "$FILE_PATH" > "$FILENAME.sha256"
gh release upload "$TAG" "$FILENAME.sha256" --repo "$REPO" --clobber
echo "完成"
echo "SHA256 校验: $(cat "$FILENAME.sha256")"