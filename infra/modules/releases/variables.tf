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
