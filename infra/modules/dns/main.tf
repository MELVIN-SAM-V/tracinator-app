# Public hosted zone for the root domain. The domain is registered outside
# AWS (e.g. Namecheap) — after this is applied, copy `name_servers` output
# into NS records at the registrar to delegate DNS to Route53. That's a
# manual, human-timescale step Terraform cannot perform (it doesn't have
# access to the registrar account), and ACM DNS validation elsewhere depends
# on this zone being authoritative — kick this off before anything else.
resource "aws_route53_zone" "root" {
  name = var.domain_name
}
