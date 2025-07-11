#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import http from "http";
import { URL } from "url";
import { exec } from "child_process";

// 多环境Token缓存管理类
class TokenCache {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.cacheDir = path.join(os.homedir(), ".theta_health_mcp");
    this.tokensFile = path.join(this.cacheDir, "tokens.json");
    this.environmentKey = this._getEnvironmentKey(endpoint);
    this.ensureCacheDir();
  }

  ensureCacheDir() {
    if (!fs.existsSync(this.cacheDir)) {
      try {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      } catch (error) {
        console.error(`❌ 无法创建缓存目录: ${error.message}`);
      }
    }
  }

  /**
   * 根据endpoint生成环境标识符
   * @param {string} endpoint - MCP端点URL
   * @returns {string} - 环境标识符
   */
  _getEnvironmentKey(endpoint) {
    try {
      const url = new URL(endpoint);
      return url.hostname.replace(/[^a-zA-Z0-9]/g, "_");
    } catch (error) {
      return "default";
    }
  }

  /**
   * 加载所有环境的tokens
   * @returns {Object} - 包含所有环境tokens的对象
   */
  _loadAllTokens() {
    try {
      if (!fs.existsSync(this.tokensFile)) {
        return {};
      }
      return JSON.parse(fs.readFileSync(this.tokensFile, "utf8"));
    } catch (error) {
      console.error(`❌ 加载tokens文件失败: ${error.message}`);
      return {};
    }
  }

  /**
   * 保存所有环境的tokens
   * @param {Object} allTokens - 包含所有环境tokens的对象
   */
  _saveAllTokens(allTokens) {
    try {
      // 添加元数据
      const tokensData = {
        ...allTokens,
        _metadata: {
          last_updated: new Date().toISOString(),
          version: "2.0",
          description: "Multi-environment token cache for Theta Health MCP",
        },
      };

      fs.writeFileSync(this.tokensFile, JSON.stringify(tokensData, null, 2));
      return true;
    } catch (error) {
      console.error(`❌ 保存tokens文件失败: ${error.message}`);
      return false;
    }
  }

  saveToken(tokenData) {
    try {
      const cacheData = {
        access_token: tokenData.access_token,
        token_type: tokenData.token_type || "Bearer",
        expires_at:
          tokenData.expires_at || Date.now() + 7 * 24 * 60 * 60 * 1000, // 默认7天
        refresh_token: tokenData.refresh_token,
        scope: tokenData.scope,
        created_at: Date.now(),
        endpoint: this.endpoint,
        environment: this.environmentKey,
        last_used: Date.now(),
      };

      // 加载所有tokens
      const allTokens = this._loadAllTokens();

      // 更新当前环境的token
      allTokens[this.environmentKey] = cacheData;

      // 保存回文件
      return this._saveAllTokens(allTokens);
    } catch (error) {
      console.error(`❌ 保存Token失败: ${error.message}`);
      return false;
    }
  }

  loadToken() {
    try {
      const allTokens = this._loadAllTokens();
      const tokenData = allTokens[this.environmentKey];

      if (!tokenData) {
        return null;
      }

      // 检查Token是否过期
      if (tokenData.expires_at && Date.now() > tokenData.expires_at) {
        return { ...tokenData, expired: true };
      }

      // 更新最后使用时间
      tokenData.last_used = Date.now();
      allTokens[this.environmentKey] = tokenData;
      this._saveAllTokens(allTokens);

      return tokenData;
    } catch (error) {
      console.error(`❌ 加载Token失败: ${error.message}`);
      return null;
    }
  }

  clearToken() {
    try {
      const allTokens = this._loadAllTokens();

      if (allTokens[this.environmentKey]) {
        delete allTokens[this.environmentKey];
        this._saveAllTokens(allTokens);
      }
    } catch (error) {
      console.error(`❌ 清除Token缓存失败: ${error.message}`);
    }
  }

  getTokenStatus() {
    const token = this.loadToken();
    if (!token) {
      return {
        status: "not_found",
        message: `Token not found for ${this.environmentKey}`,
        environment: this.environmentKey,
      };
    }

    if (token.expired) {
      return {
        status: "expired",
        message: `Token expired for ${this.environmentKey}`,
        token,
        environment: this.environmentKey,
      };
    }

    const timeLeft = Math.floor(
      (token.expires_at - Date.now()) / (1000 * 60 * 60),
    );
    return {
      status: "valid",
      message: `Token valid for ${this.environmentKey}, ${timeLeft}h left`,
      token,
      hours_left: timeLeft,
      environment: this.environmentKey,
    };
  }
}

// MCP代理类
class HttpMcpProxy {
  constructor() {
    this.server = new Server(
      {
        name: "theta-health-mcp-proxy",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.httpServiceUrl =
      process.env.THETA_HEALTH_ENDPOINT || "https://mcp.thetahealth.ai/mcp";
    this.token = process.env.THETA_HEALTH_TOKEN || null;

    // 初始化Token缓存
    this.tokenCache = new TokenCache(this.httpServiceUrl);

    // 浏览器去重机制
    this.lastBrowserOpenTime = 0;
    this.browserOpenDebounceTime = 10000; // 10秒内只弹一次窗口

    this.setupHandlers();
    this.loadCachedToken();
  }

  /**
   * 加载缓存的Token
   */
  async loadCachedToken() {
    if (this.token) {
      return this.token;
    }

    const tokenStatus = this.tokenCache.getTokenStatus();

    if (tokenStatus.status === "valid") {
      this.token = tokenStatus.token.access_token;
      console.error(`✅ 使用缓存的Token: ${this.token.substring(0, 20)}...`);
      return this.token;
    } else if (tokenStatus.status === "expired") {
      // 尝试刷新Token
      if (tokenStatus.token.refresh_token) {
        const refreshResult = await this.refreshToken(
          tokenStatus.token.refresh_token,
        );
        if (refreshResult) {
          this.token = refreshResult.access_token;
          return this.token;
        }
      }
      console.error(`⚠️ Token已过期，请重新认证`);
      return null;
    } else {
      console.error(`ℹ️ 未找到缓存的Token`);
      return null;
    }
  }

  /**
   * 刷新Token
   */
  async refreshToken(refreshToken) {
    try {
      const response = await this.makeHttpRequest({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "oauth_refresh_token",
          arguments: {
            refresh_token: refreshToken,
          },
        },
      });

      if (response && response.result && response.result.content) {
        const content = JSON.parse(response.result.content[0].text);
        if (content.success) {
          // 保存新的Token
          this.tokenCache.saveToken({
            access_token: content.access_token,
            token_type: content.token_type,
            expires_at: Date.now() + content.expires_in * 1000,
            refresh_token: content.refresh_token || refreshToken,
            scope: content.scope,
            endpoint: this.httpServiceUrl,
          });
          console.error(`✅ Token刷新成功`);
          return content;
        }
      }
      return null;
    } catch (error) {
      console.error(`❌ Token刷新失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 检查消息是否为token认证成功的响应
   */
  isTokenAuthResponse(response) {
    try {
      if (
        response.result &&
        response.result.content &&
        response.result.content[0]
      ) {
        const content = JSON.parse(response.result.content[0].text);
        return (
          content.success === true &&
          content.access_token &&
          content.token_type === "Bearer"
        );
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * 检查是否为需要打开浏览器的响应
   */
  isAutoOpenBrowserResponse(response) {
    try {
      if (
        response.result &&
        response.result.content &&
        response.result.content[0]
      ) {
        const content = JSON.parse(response.result.content[0].text);
        return content.auto_open_browser === true && content.authorization_url;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * 处理自动打开浏览器的响应
   */
  async handleAutoOpenBrowserResponse(response) {
    try {
      if (
        response.result &&
        response.result.content &&
        response.result.content[0]
      ) {
        const content = JSON.parse(response.result.content[0].text);

        if (content.auto_open_browser && content.authorization_url) {
          console.error(`🌐 检测到自动打开浏览器指令`);
          console.error(`🔗 认证URL: ${content.authorization_url}`);

          // 检查是否在去重时间内
          const currentTime = Date.now();
          const timeSinceLastOpen = currentTime - this.lastBrowserOpenTime;

          if (timeSinceLastOpen < this.browserOpenDebounceTime) {
            const remainingTime = Math.ceil(
              (this.browserOpenDebounceTime - timeSinceLastOpen) / 1000,
            );
            console.error(
              `⌛ 浏览器已在${Math.floor(
                timeSinceLastOpen / 1000,
              )}秒前打开，请等待${remainingTime}秒后再试`,
            );
            console.error(`📋 或者手动复制以下链接到浏览器:`);
            console.error(`   ${content.authorization_url}`);

            // 仍然启动自动轮询
            if (content.auto_polling && content.auto_polling.enabled) {
              console.error(`🔄 继续自动轮询，等待认证完成...`);
              this.startAutoPolling(content.auto_polling);
            }
            return true;
          }

          // 更新最后打开浏览器的时间
          this.lastBrowserOpenTime = currentTime;

          // 清除任何旧的token，因为我们正在开始新的认证流程
          console.error(`🗑️ 清除旧token，开始新的认证流程`);
          this.tokenCache.clearToken();
          this.token = null;

          // 显示客户端指令
          if (content.client_instructions) {
            console.error(`📋 认证步骤:`);
            Object.entries(content.client_instructions).forEach(
              ([key, instruction]) => {
                console.error(`   ${key.replace("step_", "")}. ${instruction}`);
              },
            );
          }

          try {
            // 尝试打开浏览器
            let command;
            switch (os.platform()) {
              case "darwin": // macOS
                command = `open "${content.authorization_url}"`;
                break;
              case "win32": // Windows
                command = `start "${content.authorization_url}"`;
                break;
              default: // Linux and others
                command = `xdg-open "${content.authorization_url}"`;
                break;
            }

            exec(command, (error) => {
              if (error) {
                console.error(`❌ 自动打开浏览器失败: ${error.message}`);
                console.error(`📋 请手动复制以下链接到浏览器:`);
                console.error(`   ${content.authorization_url}`);
              } else {
                console.error(`✅ 浏览器已自动打开，请在浏览器中完成认证`);
              }
            });
          } catch (error) {
            console.error(`❌ 打开浏览器失败: ${error.message}`);
            console.error(`📋 请手动复制以下链接到浏览器:`);
            console.error(`   ${content.authorization_url}`);
          }

          // 启动自动轮询获取token
          if (content.auto_polling && content.auto_polling.enabled) {
            console.error(`🔄 启动自动轮询，等待认证完成...`);
            this.startAutoPolling(content.auto_polling);
          }

          return true;
        }
      }
    } catch (error) {
      console.error(`❌ 处理自动打开浏览器响应失败: ${error.message}`);
    }
    return false;
  }

  /**
   * 自动轮询获取token
   */
  async startAutoPolling(pollingConfig) {
    const { state, check_interval = 3, max_wait_time = 300 } = pollingConfig;
    const startTime = Date.now();

    console.error(`⏰ 开始轮询状态，最大等待时间: ${max_wait_time}秒`);

    const poll = async () => {
      try {
        // 检查是否超时
        if (Date.now() - startTime > max_wait_time * 1000) {
          console.error(`⏰ 轮询超时，请手动检查认证状态`);
          return;
        }

        // 调用状态检查端点
        const checkUrl = `${this.httpServiceUrl.replace(
          /\/mcp$/,
          "",
        )}/oauth2/check_state/${state}`;
        const response = await this.makeHttpStateCheckRequest(checkUrl);

        if (response.status === "completed") {
          console.error(`✅ 认证完成！获取到访问令牌`);
          console.error(`🔑 Token: ${response.token.substring(0, 20)}...`);

          // 保存token
          const tokenData = {
            access_token: response.token,
            token_type: response.token_type,
            expires_at: Date.now() + 7 * 24 * 60 * 60 * 1000, // 默认7天
            endpoint: this.httpServiceUrl,
          };

          this.tokenCache.saveToken(tokenData);
          this.token = response.token;

          console.error(`🎉 认证流程完成，Token已保存，后续启动时将自动使用`);
          return;
        } else if (
          response.status === "pending" ||
          response.status === "auth_code_generated"
        ) {
          // 继续等待
          console.error(
            `⏳ 等待认证完成... (${Math.floor(
              (Date.now() - startTime) / 1000,
            )}s)`,
          );
          setTimeout(poll, check_interval * 1000);
        } else if (response.status === "expired") {
          console.error(`❌ 认证会话已过期，请重新开始认证`);
          return;
        } else if (response.status === "unauthorized") {
          console.error(`❌ 认证会话验证失败，可能的安全问题`);
          return;
        } else {
          console.error(
            `❓ 未知状态: ${response.status}, ${response.message || ""}`,
          );
          // 继续轮询，可能是临时状态
          setTimeout(poll, check_interval * 1000);
        }
      } catch (error) {
        console.error(`❌ 轮询状态检查失败: ${error.message}`);
        // 等待一段时间后重试
        setTimeout(poll, check_interval * 1000);
      }
    };

    // 开始轮询
    setTimeout(poll, check_interval * 1000);
  }

  /**
   * HTTP状态检查请求
   */
  async makeHttpStateCheckRequest(url) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === "https:";
      const httpModule = isHttps ? https : http;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname,
        method: "GET",
      };

      const req = httpModule.request(options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            if (res.statusCode === 200) {
              const response = JSON.parse(data);
              resolve(response);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          } catch (error) {
            reject(new Error(`解析响应失败: ${error.message}`));
          }
        });
      });

      req.on("error", (error) => {
        reject(error);
      });

      req.setTimeout(10000); // 10秒超时
      req.end();
    });
  }

  /**
   * 处理token认证成功的消息
   */
  async handleTokenAuthResponse(response) {
    try {
      if (
        response.result &&
        response.result.content &&
        response.result.content[0]
      ) {
        const content = JSON.parse(response.result.content[0].text);
        const newToken = content.access_token;

        if (newToken && newToken !== this.token) {
          console.error(`🔄 检测到新的访问令牌，正在更新...`);
          console.error(`🔑 新token: ${newToken.substring(0, 20)}...`);

          this.token = newToken;

          // 保存新Token到缓存
          this.tokenCache.saveToken({
            access_token: newToken,
            token_type: content.token_type || "Bearer",
            expires_at: Date.now() + (content.expires_in || 3600) * 1000,
            refresh_token: content.refresh_token,
            scope: content.scope,
            endpoint: this.httpServiceUrl,
          });

          console.error(`✅ Token更新完成并已缓存`);

          return true;
        }
      }
    } catch (error) {
      console.error(`❌ 处理token认证响应失败: ${error.message}`);
    }
    return false;
  }

  /**
   * 通用HTTP请求方法
   */
  async makeHttpRequest(data) {
    const url = new URL(this.httpServiceUrl);
    const isHttps = url.protocol === "https:";
    const httpModule = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(data);

      const headers = {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      };

      // 检查是否需要认证
      const authNotRequiredTools = [
        "start_authentication",
        "get_code",
        "oauth_exchange_code_for_token",
        "oauth_refresh_token",
        "oauth_validate_token",
        "tools/list",
        "resources/list",
        "prompts/list",
      ];

      const needsAuth = !(
        data.method === "tools/list" ||
        data.method === "resources/list" ||
        data.method === "prompts/list" ||
        (data.method === "tools/call" &&
          authNotRequiredTools.includes(data.params?.name))
      );

      if (needsAuth && this.token) {
        headers["Authorization"] = `Bearer ${this.token}`;
      }

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: headers,
      };

      const req = httpModule.request(options, (res) => {
        let responseData = "";

        res.on("data", (chunk) => {
          responseData += chunk;
        });

        res.on("end", () => {
          try {
            const jsonResponse = JSON.parse(responseData);
            resolve(jsonResponse);
          } catch (error) {
            reject(new Error("Invalid JSON response"));
          }
        });
      });

      req.on("error", (error) => {
        reject(error);
      });

      req.setTimeout(10000); // 10秒超时
      req.write(postData);
      req.end();
    });
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        // 从远程 HTTP MCP 服务获取工具列表
        const response = await this.makeHttpRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        });

        return {
          tools: response.result?.tools || [],
        };
      } catch (error) {
        console.error("Error fetching tools:", error);
        return { tools: [] };
      }
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        // 将工具调用转发到远程 HTTP MCP 服务
        const response = await this.makeHttpRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: request.params.name,
            arguments: request.params.arguments,
          },
        });

        // 检查是否为token认证成功的响应
        if (this.isTokenAuthResponse(response)) {
          await this.handleTokenAuthResponse(response);
        }

        // 检查是否为自动打开浏览器的响应
        if (this.isAutoOpenBrowserResponse(response)) {
          await this.handleAutoOpenBrowserResponse(response);
        }

        return {
          content: response.result?.content || [
            {
              type: "text",
              text: JSON.stringify(response.result || {}),
            },
          ],
        };
      } catch (error) {
        console.error("Error calling tool:", error);
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}`,
            },
          ],
        };
      }
    });
  }

  // 获取授权URL
  async getAuthorizationUrl() {
    try {
      const response = await this.makeHttpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "start_authentication",
          arguments: { random_string: "mcp_client_auth" },
        },
      });

      if (response && response.result && response.result.content) {
        const content = JSON.parse(response.result.content[0].text);
        return content;
      }
      return null;
    } catch (error) {
      console.error("获取授权URL失败:", error.message);
      return null;
    }
  }

  // 运行MCP代理
  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Theta Health MCP proxy server running on stdio");
    console.error(`🔗 连接到: ${this.httpServiceUrl}`);
    console.error(
      `🔑 Token状态: ${this.token ? "Available" : "Not available"}`,
    );

    // 显示Token状态
    const tokenStatus = this.tokenCache.getTokenStatus();
    if (tokenStatus.status === "valid") {
      console.error(`✅ Token有效，剩余时间: ${tokenStatus.hours_left}小时`);
    } else if (tokenStatus.status === "expired") {
      console.error(`⚠️ Token已过期，建议重新认证`);
    } else {
      console.error(`ℹ️ 未找到Token，可能需要认证`);
    }
  }
}

// 创建并运行MCP代理
const proxy = new HttpMcpProxy();
proxy.run().catch(console.error);
