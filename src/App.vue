<template>
  <div style="max-width: 400px; margin: auto; padding: 32px">
    <el-button
      v-if="!streaming"
      type="primary"
      @click="startStreaming"
      :loading="loading"
    >
      开始推流
    </el-button>
    <el-alert
      v-if="errorMsg"
      :title="errorMsg"
      type="error"
      show-icon
      style="margin-top: 16px"
    />
    <video
      ref="previewVideo"
      autoplay
      controls
      playsinline
      :style="
        isMobileFullscreen
          ? 'width:100vw;height:100vh;object-fit:cover;background:#000;margin-top:0;position:fixed;top:0;left:0;z-index:9999'
          : isMobile()
          ? 'width:100vw;height:100vh;object-fit:cover;background:#000;margin-top:0'
          : 'width:100%;margin-top:16px'
      "
    />
  </div>
</template>

<script setup>
import { ref } from "vue";
import { ElMessage } from "element-plus";
import { WHIPClient } from "./whip.js";

const WHIP_URL =
  "https://5da6-58-248-106-93.ngrok-free.app/index/api/whip?app=live&stream=123456";

const loading = ref(false);
const errorMsg = ref("");
const previewVideo = ref(null);
const streaming = ref(false);
const isMobileFullscreen = ref(false);

let whipClient = null;
let pc = null;

function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

async function startStreaming() {
  errorMsg.value = "";
  loading.value = true;
  try {
    let stream;

    if (isMobile()) {
      // 手机端：捕获后置摄像头并在canvas中顺时针旋转90°
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });

      const videoEl = document.createElement("video");
      videoEl.srcObject = stream;
      await videoEl.play();

      const canvas = document.createElement("canvas");
      canvas.width = videoEl.videoHeight || 1080;
      canvas.height = videoEl.videoWidth || 1920;

      const ctx = canvas.getContext("2d");

      function drawRotated() {
        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.translate(canvas.width / 2, canvas.height / 2);
        // ctx.rotate(Math.PI / 2); // 顺时针90°
        ctx.drawImage(
          videoEl,
          -videoEl.videoWidth / 2,
          -videoEl.videoHeight / 2
        );
        ctx.restore();
        requestAnimationFrame(drawRotated);
      }

      drawRotated();

      stream = canvas.captureStream(30);
    } else {
      // PC端：捕获屏幕内容
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });
    }

    // 本地预览，并在手机上请求全屏+锁定横屏+标记变量以便CSS控制方向，无需额外transform！
    if (previewVideo.value) {
      previewVideo.value.srcObject = stream;
      previewVideo.value.play();

      if (isMobile()) {
        setTimeout(async () => {
          try {
            if (previewVideo.value.requestFullscreen) {
              await previewVideo.value.requestFullscreen();
              isMobileFullscreen.value = true;
            }
            if (
              window.screen.orientation &&
              window.screen.orientation.lock &&
              typeof window.screen.orientation.lock === "function"
            ) {
              await window.screen.orientation.lock("landscape");
            }
          } catch (e) {
            console.warn("全屏或横屏失败", e);
          }
        }, 300);
      }
    }

    pc?.close();
    pc = new RTCPeerConnection({ bundlePolicy: "max-bundle" });

    for (const track of stream.getTracks()) {
      pc.addTransceiver(track, stream);
    }

    whipClient?.stop && whipClient.stop();
    whipClient = new WHIPClient();

    await whipClient.publish(pc, WHIP_URL);

    streaming.value = true;

    ElMessage.success("推流已开始！");
  } catch (err) {
    console.error(err);
    errorMsg.value = err.message || "推流失败，请检查权限或网络";
  }
  loading.value = false;
}
</script>
