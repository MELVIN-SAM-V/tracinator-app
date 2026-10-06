variable "domain_name" {
  description = "Full custom domain releases are served from, e.g. releases.example.com."
  type        = string
}

variable "zone_id" {
  type = string
}

variable "certificate_arn" {
  description = "ACM cert ARN, must be in us-east-1 (CloudFront requirement)."
  type        = string
}

variable "bucket_name" {
  type = string
}

variable "download_rate_limit" {
  description = "Non-manifest requests (installer downloads, in practice) allowed per IP within download_rate_window_sec before WAF blocks that IP. AWS's minimum is 10."
  type        = number
  default     = 10
}

variable "download_rate_window_sec" {
  description = "Rolling window for download_rate_limit. AWS allows 60, 120, 300 or 600."
  type        = number
  default     = 300
}
