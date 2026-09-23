variable "domain_name" {
  description = "Fully-qualified domain the certificate covers (e.g. demo.example.com)."
  type        = string
}

variable "zone_id" {
  description = "Route53 hosted zone ID to write the DNS validation record into."
  type        = string
}

variable "subject_alternative_names" {
  description = "Extra domains the certificate should also cover (e.g. www.example.com)."
  type        = list(string)
  default     = []
}
