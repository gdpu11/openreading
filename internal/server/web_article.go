package server

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func publicArticleURL(raw string) (*url.URL, error) {
	u, e := url.Parse(raw)
	if e != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || len(raw) > 4096 {
		return nil, problem(400, "INVALID_URL", "请输入不带账号密码的 HTTP 或 HTTPS 网页地址", false)
	}
	if p := u.Port(); p != "" && p != "80" && p != "443" {
		return nil, problem(400, "INVALID_URL", "仅支持标准网页端口", false)
	}
	return u, nil
}
func publicArticleIP(ip net.IP) bool {
	return ip != nil && ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsUnspecified() && !(&net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}).Contains(ip)
}
func (s *Server) articleRoutes() {
	s.route("POST /api/articles/preview", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		u, e := publicArticleURL(str(b, "url"))
		if e != nil {
			return e
		}
		transport := &http.Transport{Proxy: nil, ResponseHeaderTimeout: 10 * time.Second, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, e := net.SplitHostPort(address)
			if e != nil {
				return nil, e
			}
			ips, e := net.DefaultResolver.LookupIPAddr(ctx, host)
			if e != nil {
				return nil, e
			}
			if len(ips) == 0 {
				return nil, fmt.Errorf("empty DNS")
			}
			for _, ip := range ips {
				if !publicArticleIP(ip.IP) {
					return nil, problem(400, "PRIVATE_URL", "不能导入本机、内网或保留地址", false)
				}
			}
			return (&net.Dialer{Timeout: 8 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
		}}
		defer transport.CloseIdleConnections()
		client := &http.Client{Transport: transport, Timeout: 20 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects")
			}
			_, e := publicArticleURL(req.URL.String())
			return e
		}}
		req, e := http.NewRequestWithContext(r.Context(), "GET", u.String(), nil)
		if e != nil {
			return e
		}
		req.Header.Set("User-Agent", "OpenReading/1.6 Article Import")
		req.Header.Set("Accept", "text/html,application/xhtml+xml")
		response, e := client.Do(req)
		if e != nil {
			return problem(400, "ARTICLE_UNAVAILABLE", "无法读取网页；请确认地址公开可访问，内网地址不支持导入", false)
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return problem(400, "ARTICLE_UNAVAILABLE", "网页需要登录、限制访问或暂时不可用", false)
		}
		kind := strings.ToLower(response.Header.Get("Content-Type"))
		if !strings.Contains(kind, "text/html") && !strings.Contains(kind, "application/xhtml+xml") {
			return problem(400, "UNSUPPORTED_ARTICLE", "此地址不是 HTML 网页", false)
		}
		data, e := io.ReadAll(io.LimitReader(response.Body, 5<<20+1))
		if e != nil {
			return e
		}
		if len(data) > 5<<20 {
			return problem(413, "ARTICLE_TOO_LARGE", "网页超过 5 MB", false)
		}
		return send(w, M{"url": response.Request.URL.String(), "html": string(data)})
	})
}
