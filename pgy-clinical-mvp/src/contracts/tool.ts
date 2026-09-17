/** Tool 描述符：执行确定动作，不拥有临床主权。 */
export interface RuntimeToolDescriptor {
  id: string;
  description: string;
  risk?: 'low' | 'medium' | 'high';
}
