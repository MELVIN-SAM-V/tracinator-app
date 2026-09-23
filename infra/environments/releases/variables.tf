variable "domain_name" {
  description = "Root domain whose existing zone (owned by the demo environment) this adds a releases.* record to, e.g. example.com."
  type        = string
}

variable "aws_region" {
  description = "Primary region for the S3 bucket. ACM + CloudFront always use us-east-1 regardless of this."
  type        = string
  default     = "us-east-2"
}
