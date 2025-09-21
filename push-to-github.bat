@echo off
echo 正在推送到 GitHub...
echo.

echo 推送代码更改...
git push
if %errorlevel% neq 0 (
    echo 代码推送失败，请检查网络连接
    pause
    exit /b 1
)

echo.
echo 推送标签...
git push origin v0.1.0
if %errorlevel% neq 0 (
    echo 标签推送失败，请检查网络连接
    pause
    exit /b 1
)

echo.
echo ✅ 推送完成！
echo.
echo 下一步：
echo 1. 访问 https://github.com/amazinday/embedded-note-enhancer/releases/new
echo 2. 创建新的 Release v0.1.0
echo 3. 上传 embedded-note-enhancer-v0.1.0.zip 文件
echo 4. 使用 release-notes.md 中的内容作为 Release 描述
echo.
pause
