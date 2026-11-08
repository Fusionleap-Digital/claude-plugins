variable "region" {
  type    = string
  default = "us-east-1"
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "env" {
  type    = string
  default = "prod"
}
