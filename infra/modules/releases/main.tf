# Static hosting for the desktop app's per-platform update manifests
# (<platform>/latest.json) and
# installer files — what tauri-plugin-updater's check() fetches (see
# src-tauri/tauri.conf.json's plugins.updater.endpoints and
# infra/scripts/publish_release.sh, which is what actually uploads here).
#
# Deliberately much simpler than ../frontend: no SPA routing (there's no
# app here, just files) and no API origin. The one WAF rule below exists
# because this domain is published in an open-source repo: the cost risk
# isn't compute but bandwidth, from a script downloading the ~35 MB
# installers in a loop. The manifests are left unlimited so normal update
# checks can never be blocked.

# The WAF web ACL for a CloudFront distribution must live in us-east-1,
# same requirement as the ACM cert.
terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.us_east_1]
    }
  }
}

resource "aws_s3_bucket" "releases" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_public_access_block" "releases" {
  bucket                  = aws_s3_bucket.releases.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "releases" {
  name                              = "${var.bucket_name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "bucket_policy" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.releases.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "releases" {
  bucket = aws_s3_bucket.releases.id
  policy = data.aws_iam_policy_document.bucket_policy.json
}

locals {
  # WAFv2 name/metric_name only allow alphanumeric, hyphen, underscore —
  # bucket_name is a domain and contains dots.
  waf_name = replace(var.bucket_name, ".", "-")
}

resource "aws_wafv2_web_acl" "this" {
  provider    = aws.us_east_1
  name        = "${local.waf_name}-waf"
  description = "Rate-limits per-IP installer downloads to bound bandwidth cost from scripted abuse."
  scope       = "CLOUDFRONT"

  # AWS refuses to delete a web ACL still attached to a distribution, so a
  # replacement must be created and attached before the old one goes.
  lifecycle {
    create_before_destroy = true
  }

  default_action {
    allow {}
  }

  rule {
    name     = "installer-download-rate-limit"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = var.download_rate_limit
        evaluation_window_sec = var.download_rate_window_sec
        aggregate_key_type    = "IP"

        # Counts every request except the manifests, rather than matching
        # installer paths, so it keeps covering installers if their layout
        # under v<version>/ ever changes.
        scope_down_statement {
          not_statement {
            statement {
              byte_match_statement {
                search_string         = "/latest.json"
                positional_constraint = "ENDS_WITH"

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.waf_name}-download-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.waf_name}-waf"
    sampled_requests_enabled   = true
  }
}

resource "aws_cloudfront_distribution" "this" {
  enabled    = true
  aliases    = [var.domain_name]
  web_acl_id = aws_wafv2_web_acl.this.arn

  origin {
    domain_name              = aws_s3_bucket.releases.bucket_regional_domain_name
    origin_id                = "s3-releases"
    origin_access_control_id = aws_cloudfront_origin_access_control.releases.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-releases"
    viewer_protocol_policy = "redirect-to-https"
    # AWS managed: CachingOptimized. The manifests change on every release —
    # publish_release.sh invalidates /<platform>/latest.json on each publish rather
    # than relying on a short TTL, so this can stay the same
    # bandwidth-friendly policy the installers themselves benefit from.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "alias" {
  zone_id = var.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}
