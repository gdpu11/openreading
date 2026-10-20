package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"openreading/internal/server"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	public := flag.String("public-url", "", "受信任的 HTTPS 公网来源；应用仍仅监听 127.0.0.1，置于反向代理后")
	data := flag.String("data-dir", "", "应用数据目录（默认系统应用配置目录/OpenReading）")
	port := flag.Int("port", 7318, "本机 HTTP 端口")
	machine := flag.Bool("machine-readable", false, "输出供桌面客户端读取的就绪事件")
	mock := flag.Bool("allow-mock", false, "明确启用开发用模拟服务（界面显示模拟标记）")
	apk := flag.String("android-apk", "", "供手机扫码下载的 Android APK 安装包")
	interval := flag.Duration("scan-interval", time.Minute, "目录补偿扫描周期")
	flag.Parse()
	if *interval < 10*time.Second {
		log.Fatal("scan-interval 至少 10s")
	}
	s, e := server.New(server.Config{AndroidAPK: *apk, PublicOrigin: *public, AccessCode: os.Getenv("OPENREADING_ACCESS_CODE"), DataDir: *data, AllowMock: *mock, ScanInterval: *interval})
	if e != nil {
		log.Fatalf("无法打开数据目录：%v", e)
	}
	defer s.Close()
	listener, e := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if e != nil {
		log.Fatalf("本机端口不可用：%v", e)
	}
	if *machine {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"type": "ready", "url": "http://" + listener.Addr().String(), "code": s.PairCode()})
	} else {
		fmt.Printf("\nOpen Reading 1.6.6\n打开：http://%s\n本次服务配对码：%s\n原始资料按需连接；API Key 仅保存在本次进程内存。\n", listener.Addr(), s.PairCode())
	}

	httpServer := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20}
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-done
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
	}()
	if e = httpServer.Serve(listener); e != nil && e != http.ErrServerClosed {
		log.Printf("本机服务停止：%v", e)
	}
}
