terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ACM (CloudFront certs) must live in us-east-1 regardless of where the rest
# of the stack runs — same requirement as the demo environment.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

locals {
  full_domain = "releases.${var.domain_name}"
}

# Not module.dns — that creates a *new* hosted zone, and demo's already owns
# domain_name's zone (tracinator.com). A subdomain here just needs a record
# in that existing zone, same reasoning as the dev.tracinator.com scoping
# this was modeled on.
data "aws_route53_zone" "root" {
  name         = var.domain_name
  private_zone = false
}

module "acm" {
  source = "../../modules/acm"
  providers = {
    aws.us_east_1 = aws.us_east_1
  }
  domain_name = local.full_domain
  zone_id     = data.aws_route53_zone.root.zone_id
}

module "releases" {
  source          = "../../modules/releases"
  domain_name     = local.full_domain
  zone_id         = data.aws_route53_zone.root.zone_id
  certificate_arn = module.acm.certificate_arn
  bucket_name     = local.full_domain
}
