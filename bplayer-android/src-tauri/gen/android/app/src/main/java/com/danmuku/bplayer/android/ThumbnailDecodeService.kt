package com.danmuku.bplayer.android

import android.app.Service
import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaDataSource
import android.media.MediaMetadataRetriever
import android.os.Binder
import android.os.IBinder
import android.os.Parcel
import android.os.Process
import java.io.ByteArrayOutputStream
import java.io.IOException

internal object ThumbnailWire {
  const val DESCRIPTOR = "com.danmuku.bplayer.thumbnail.v1"
  const val START = 1
  const val READ = 2
  const val RESULT = 4
  const val STOP = 5
  const val PROGRESS = 6
  fun parcel(): Parcel = Parcel.obtain().apply { writeInterfaceToken(DESCRIPTOR) }
}

class ThumbnailDecodeService : Service() {
  private var started = false
  @Volatile private var taskId: String? = null
  private val handler = android.os.Handler(android.os.Looper.getMainLooper())
  private fun isolated(): Boolean {
    val name = if (android.os.Build.VERSION.SDK_INT >= 28) android.app.Application.getProcessName() else {
      val manager = getSystemService(android.content.Context.ACTIVITY_SERVICE) as android.app.ActivityManager
      manager.runningAppProcesses?.firstOrNull { it.pid == Process.myPid() }?.processName
    }
    return name == "$packageName:thumbnails"
  }
  private fun terminate() { if (isolated()) Process.killProcess(Process.myPid()) }
  override fun onCreate() {
    super.onCreate()
    if (isolated()) handler.postDelayed({ terminate() }, 4000) else stopSelf()
  }
  override fun onDestroy() { handler.removeCallbacksAndMessages(null); super.onDestroy(); terminate() }
  override fun onBind(intent: Intent?): IBinder? = if (!isolated()) null else object : Binder() {
    override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
      if (code == ThumbnailWire.STOP) {
        data.enforceInterface(ThumbnailWire.DESCRIPTOR)
        val requested = data.readString()
        if (taskId == null || requested == taskId) terminate()
        return true
      }
      if (code != ThumbnailWire.START) return super.onTransact(code, data, reply, flags)
      data.enforceInterface(ThumbnailWire.DESCRIPTOR)
      val requested = data.readString()?.takeIf { it.length in 1..128 } ?: return false
      val source = data.readStrongBinder() ?: return false
      val callback = data.readStrongBinder() ?: return false
      val size = data.readLong()
      synchronized(this@ThumbnailDecodeService) {
        if (started) return false
        started = true
        taskId = requested
      }
      Thread({ decode(source, callback, size) }, "thumbnail-decoder").apply { isDaemon = true; start() }
      return true
    }
  }

  private fun nearBlack(bitmap: Bitmap): Boolean {
    val columns = minOf(16, bitmap.width)
    val rows = minOf(16, bitmap.height)
    val pixels = IntArray(columns * rows)
    for (row in 0 until rows) {
      for (column in 0 until columns) {
        val x = ((column * 2 + 1) * bitmap.width / (columns * 2)).coerceAtMost(bitmap.width - 1)
        val y = ((row * 2 + 1) * bitmap.height / (rows * 2)).coerceAtMost(bitmap.height - 1)
        pixels[row * columns + column] = bitmap.getPixel(x, y)
      }
    }
    return ThumbnailFrames.nearBlack(pixels)
  }

  private fun decode(source: IBinder, callback: IBinder, size: Long) {
    var retriever: MediaMetadataRetriever? = null
    var bitmap: Bitmap? = null
    var bytes: ByteArray? = null
    try {
      fun progress(stage: String) {
        val message = ThumbnailWire.parcel()
        try { message.writeString(stage); callback.transact(ThumbnailWire.PROGRESS, message, null, IBinder.FLAG_ONEWAY) }
        finally { message.recycle() }
      }
      retriever = MediaMetadataRetriever()
      val readCache = ThumbnailReadCache(size, { position, buffer, offset, length ->
        val request = ThumbnailWire.parcel()
        val response = Parcel.obtain()
        try {
          request.writeLong(position); request.writeInt(length)
          if (!source.transact(ThumbnailWire.READ, request, response, 0)) throw IOException("Thumbnail source closed")
          response.readException()
          val count = response.readInt()
          if (count < 0) -1 else {
            val payload = response.createByteArray() ?: throw IOException("Thumbnail source empty")
            if (count > length || count != payload.size) throw IOException("Thumbnail source invalid")
            System.arraycopy(payload, 0, buffer, offset, count)
            count
          }
        } finally { response.recycle(); request.recycle() }
      })
      progress("metadata")
      retriever.setDataSource(object : MediaDataSource() {
        override fun getSize(): Long = size
        override fun close() = Unit
        override fun readAt(position: Long, buffer: ByteArray, offset: Int, length: Int): Int =
          readCache.readAt(position, buffer, offset, length)
      })
      if (android.os.Build.VERSION.SDK_INT < 27) throw IOException("Scaled thumbnails are unsupported")
      val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
      val durationUs = durationMs?.takeIf { it > 0 && it <= Long.MAX_VALUE / 1000 }?.times(1000)
      progress("frame")
      for (position in ThumbnailFrames.positions(durationUs)) {
        bitmap = retriever.getScaledFrameAtTime(position, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 320, 320)
        val frame = bitmap
        if (frame != null && !nearBlack(frame)) break
        frame?.recycle()
        bitmap = null
      }
      if (bitmap != null) {
        val output = ByteArrayOutputStream()
        if (bitmap.compress(Bitmap.CompressFormat.JPEG, 75, output) && output.size() <= 262144) bytes = output.toByteArray()
      }
    } catch (_: Exception) {
      bytes = null
    } finally {
      bitmap?.recycle()
      runCatching { retriever?.release() }
      val result = ThumbnailWire.parcel()
      try {
        result.writeByteArray(bytes)
        callback.transact(ThumbnailWire.RESULT, result, null, IBinder.FLAG_ONEWAY)
      } catch (_: Exception) {
        Unit
      } finally {
        result.recycle()
        terminate()
      }
    }
  }
}
