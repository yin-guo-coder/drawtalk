# Drawtalk

## 项目相关资料

- [点击查看 Drawtalk 项目讲解视频](docs/drawtalk-demo.mp4)
- [点击查看 Drawtalk 项目产品 PRD（飞书）](https://my.feishu.cn/docx/UpxEdepqJo57iKxLw7Yc6a2knHf)

> 如果 PRD 链接无法访问，请在飞书文档右上角打开「分享」，将链接权限设置为「互联网上获得链接的人可阅读」或「获得链接的人可阅读」，然后用飞书复制出的公开分享链接替换上方地址。

Drawtalk 是一个纯语音优先的 AI 绘图 Web MVP。用户通过按住麦克风说出绘图需求，系统完成语音转写、AI 复述确认、文生图、版本管理、语音修改和局部重绘。绘图时会根据用户年龄，性别等信息改变绘图及复述风格。

当前项目重点验证完整产品链路，不追求复杂移动端适配。

## 已实现功能

- 前导页：展示 `drawtalk`、产品副标题和“开始使用”按钮。
- 语音输入：按住说话，松开后上传录音并转写。
- 语音转写：默认使用 MiMo ASR，也保留浏览器语音识别兜底。
- 说话人分析：绘图需求阶段会识别性别、年龄和情感，并展示在侧边栏。
- AI 复述确认：系统会复述理解到的绘图需求，用户说“确认”后才生成图片。
- 文生图：支持 AI Horde 和 GPT Image 选项，默认使用 AI Horde。
- 版本管理：每次生成、编辑都会保存新版本，支持版本列表展示、回到上一版、回到第 N 版、基于某版继续改。
- 个性化语音复述：根据识别到的年龄、性别、情感调整 AI 回复文本和浏览器 TTS 语音参数。
- 当前图片语音修改：支持类似“把背景换成夜晚城市”“人物不要变，只改衣服颜色”的语音修改意图。
- 局部重绘：系统根据语音自动推断重绘区域，例如背景、左侧区域、右侧区域、人物衣服等；确认后生成新版本。

## 当前交互流程

1. 打开页面，点击“开始使用”。
2. 按住麦克风说出绘图需求，例如：
   `帮我画一只赛博朋克风格的猫`
3. 系统转写语音，并在需要时分析说话人年龄、性别、情感。
4. AI 复述理解结果。
5. 用户说“确认”。
6. 将用户prompt，说话人年龄、性别、情感等一起提交给生图大模型，系统生成图片并保存为一个版本。
7. 用户可以继续说：
   `把背景换成夜晚城市`
   `人物不要变，只改衣服颜色`
   `回到上一版`
   `用第一版继续改`

## 运行方式

项目不依赖前端构建工具，直接运行 Node 服务即可。

```bash
npm start
```

默认地址：

```text
http://127.0.0.1:3000/
```

如果修改了 `server.js`，需要重启 Node 服务后后端接口才会生效。

## 环境变量

项目会自动读取根目录下的 `.env` 文件。

常用配置示例：

```env
TRANSCRIBE_PROVIDER=mimo
MIMO_ASR_BASE_URL=https://xiaomimimo-mimo-v2-5-asr.hf.space

SPEAKER_ANALYSIS_PROVIDER=audeering
AUDEERING_API_URL=https://audeering-speech-analysis.hf.space

IMAGE_PROVIDER=horde
HORDE_API_KEY=0000000000
HORDE_IMAGE_MODEL=auto
HORDE_STEPS=10
HORDE_TIMEOUT_MS=300000

OPENAI_API_KEY=
OPENAI_IMAGE_MODEL=gpt-image-1
```

说明：

- `HORDE_API_KEY=0000000000` 可以使用 AI Horde 匿名模式，但速度和稳定性取决于公共队列。
- 如果使用 GPT Image，需要配置 `OPENAI_API_KEY`。
- 如果网络需要代理，可以配置 `OPENAI_PROXY`、`HTTPS_PROXY` 或 `HTTP_PROXY`。

## 主要接口

- `POST /api/transcribe`：上传音频并返回转写文本。
- `POST /api/analyze-speaker`：分析说话人性别、年龄段和情感。
- `POST /api/command`：把语音文本解析成生成、确认、修改、回退等结构化命令。
- `POST /api/generate-image`：根据 prompt 生成图片并保存版本。
- `POST /api/edit-image`：根据当前版本和语音修改命令执行局部重绘，并保存新版本。
- `GET /api/versions`：读取版本列表。
- `POST /api/versions/restore`：回退到指定版本或上一版本。

## 数据存储

当前 MVP 不使用数据库。

- 生成图片和本地预览保存在 `outputs/`。
- 版本记录保存在 `outputs/versions.json`。
- `.env`、`outputs/`、`.tmp/` 不提交到 Git。

## 局部重绘说明

当前局部重绘不是鼠标框选，而是纯语音描述：

```text
把背景换成夜晚城市
把左边的杯子删掉
人物不要变，只改衣服颜色
```

系统会从语音中推断重绘区域：

- 背景
- 左侧区域
- 右侧区域
- 上方区域
- 下方区域
- 人物区域
- 人物衣服
- 主体区域

后端会优先尝试 AI Horde inpainting。如果外部模型不可用、超时，或当前图片格式不支持编辑，会生成一个本地局部重绘预览版本，保证版本链路可以继续验收。

## 当前限制

- 外部免费模型服务可能超时或不可用。
- 局部重绘的自动区域推断是 MVP 级规则识别，不是精细语义分割。
- GPT Image 需要有效的 OpenAI API Key以及足够的额度。
- 浏览器 TTS 使用系统可用语音，不同电脑上的声音效果会不同。
